import type { AccountConfig, AccountState, InstrumentSpec, Timeframe, Candle } from "../types";
import { parseDrawings, type Drawing } from "./drawings";
import { supabase } from "./supabase";

const LOCAL_PREFIX = "calyze:saves:v1:";
const VERSION = 1 as const;

export interface DatasetIdentity {
  key: string;
  name: string;
  fileName: string;
  sizeBytes: number;
  count: number;
  firstTime: number;
  lastTime: number;
  cloudDatasetId: string | null;
}

export interface SaveStateSnapshot {
  version: typeof VERSION;
  dataset: DatasetIdentity;
  accountName: string;
  replayIndex: number;
  replayTime: number;
  timeframe: Timeframe;
  speed: number;
  accountConfig: AccountConfig;
  instrument: InstrumentSpec;
  account: AccountState;
  ticket: { lots: number; stopLoss: string; takeProfit: string };
  drawings: Drawing[];
  savedAt: string;
}

export interface SaveSlot {
  id: string;
  name: string;
  kind: "auto" | "manual";
  datasetKey: string;
  updatedAt: string;
  snapshot: SaveStateSnapshot;
  source?: "local" | "cloud";
}

export function makeDatasetIdentity(
  file: File, candles: Candle[], name: string, cloudDatasetId: string | null = null
): DatasetIdentity {
  if (!candles.length) throw new Error("No candles for the dataset.");
  const count = candles.length;
  const firstTime = candles[0].time;
  const lastTime = candles[count - 1].time;
  return {
    key: JSON.stringify([file.name, file.size, count, firstTime, lastTime]),
    name, fileName: file.name, sizeBytes: file.size, count, firstTime, lastTime,
    cloudDatasetId
  };
}

export function snapshotsMatch(
  a: DatasetIdentity | null, b: DatasetIdentity
): boolean {
  return Boolean(a && (a.key === b.key ||
    (a.cloudDatasetId && a.cloudDatasetId === b.cloudDatasetId)));
}

export function isSnapshot(value: unknown): value is SaveStateSnapshot {
  if (!value || typeof value !== "object") return false;
  const s = value as Partial<SaveStateSnapshot>;
  if (s.version !== VERSION || !s.dataset || !s.account || !s.accountConfig || !s.instrument || !s.ticket) {
    return false;
  }
  const d = s.dataset;
  return typeof d.key === "string" && d.key.length > 0 &&
    typeof d.fileName === "string" && typeof d.name === "string" &&
    Number.isFinite(d.count) && d.count > 0 &&
    Number.isFinite(d.firstTime) && Number.isFinite(d.lastTime) &&
    Number.isFinite(s.replayTime) && Number.isInteger(s.replayIndex) &&
    (s.replayIndex ?? -1) >= 0 &&
    ["M1", "M5", "M15", "M30", "H1", "H4", "D1"].includes(s.timeframe ?? "") &&
    Number.isFinite(s.account.balance) &&
    Array.isArray(s.account.positions) && Array.isArray(s.account.history) &&
    Number.isFinite(s.accountConfig.leverage) && s.accountConfig.leverage > 0 &&
    Number.isFinite(s.instrument.contractSize) && s.instrument.contractSize > 0 &&
    Number.isFinite(s.ticket.lots) && s.ticket.lots > 0 &&
    typeof s.accountName === "string" &&
    typeof s.ticket.stopLoss === "string" && typeof s.ticket.takeProfit === "string" &&
    Array.isArray(s.drawings) && typeof s.savedAt === "string";
}

function parseSlot(value: unknown): SaveSlot | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Partial<SaveSlot>;
  if (typeof s.id !== "string" || typeof s.name !== "string" ||
      typeof s.updatedAt !== "string" || (s.kind !== "manual" && s.kind !== "auto") ||
      !isSnapshot(s.snapshot)) return null;
  return {
    id: s.id, name: s.name, kind: s.kind, updatedAt: s.updatedAt,
    datasetKey: s.snapshot.dataset.key,
    snapshot: { ...s.snapshot, drawings: parseDrawings(s.snapshot.drawings) },
    source: "local"
  };
}

function localKey(ownerId: string): string {
  return LOCAL_PREFIX + ownerId;
}

export function listLocalSaves(ownerId: string): SaveSlot[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(localKey(ownerId)) || "[]");
    if (!Array.isArray(value)) return [];
    return value.map(parseSlot).filter((slot): slot is SaveSlot => slot !== null)
      .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch { return []; }
}

function writeLocalSaves(ownerId: string, slots: SaveSlot[]): void {
  // Keep the latest automatic checkpoint and at most 24 named profiles.
  const auto = slots.filter((slot) => slot.kind === "auto").slice(0, 1);
  const manual = slots.filter((slot) => slot.kind === "manual")
    .sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 24);
  localStorage.setItem(localKey(ownerId), JSON.stringify([...auto, ...manual]));
}

export function putLocalSave(ownerId: string, slot: SaveSlot): void {
  const current = listLocalSaves(ownerId).filter((item) => item.id !== slot.id &&
    !(slot.kind === "auto" && item.kind === "auto"));
  writeLocalSaves(ownerId, [slot, ...current]);
}

export function removeLocalSave(ownerId: string, id: string): void {
  writeLocalSaves(ownerId, listLocalSaves(ownerId).filter((slot) => slot.id !== id));
}

export function createSlot(
  snapshot: SaveStateSnapshot, name: string, kind: SaveSlot["kind"], id: string = crypto.randomUUID()
): SaveSlot {
  const updatedAt = new Date().toISOString();
  return { id, name: name.trim().slice(0,100) || "Backtest", kind,
    datasetKey: snapshot.dataset.key, updatedAt,
    snapshot: { ...snapshot, savedAt: updatedAt }, source: "local" };
}

export function mergedSaves(local: SaveSlot[], cloud: SaveSlot[]): SaveSlot[] {
  const map = new Map<string,SaveSlot>();
  for (const slot of [...local, ...cloud]) {
    const previous = map.get(slot.id);
    if (!previous || previous.updatedAt <= slot.updatedAt) map.set(slot.id, slot);
  }
  return [...map.values()].sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
}

function getClient() {
  if (!supabase) throw new Error("Supabase is not configured.");
  return supabase;
}

export async function saveCloudState(ownerId: string, slot: SaveSlot): Promise<void> {
  const client = getClient();
  const { error } = await client.from("backtest_save_states").upsert({
    id: slot.id, user_id: ownerId, name: slot.name, kind: slot.kind,
    dataset_id: slot.snapshot.dataset.cloudDatasetId || null,
    dataset_key: slot.datasetKey,
    snapshot: slot.snapshot,
    updated_at: slot.updatedAt
  }, { onConflict: "id" });
  if (error) throw new Error(error.message);
}

export async function fetchCloudStates(ownerId: string): Promise<SaveSlot[]> {
  const client = getClient();
  const { data, error } = await client.from("backtest_save_states")
    .select("id,name,kind,updated_at,snapshot")
    .eq("user_id", ownerId)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return (data ?? []).map((row): SaveSlot | null => {
    if (!isSnapshot(row.snapshot)) return null;
    return {
      id: row.id as string, name: row.name as string,
      kind: row.kind as SaveSlot["kind"],
      datasetKey: row.snapshot.dataset.key,
      updatedAt: row.updated_at as string,
      snapshot: {
        ...row.snapshot,
        drawings: parseDrawings(row.snapshot.drawings)
      },
      source: "cloud"
    };
  }).filter((slot): slot is SaveSlot => slot !== null);
}

export async function deleteCloudState(ownerId: string, id: string): Promise<void> {
  const client = getClient();
  const { error } = await client.from("backtest_save_states")
    .delete().eq("id",id).eq("user_id",ownerId);
  if (error) throw new Error(error.message);
}

export function drawingStorageKey(ownerId: string, datasetName: string, symbol: string): string {
  return "calyze:drawings:v2:" + ownerId + ":" + datasetName + ":" + symbol;
}

export function readStoredDrawings(ownerId: string, datasetName: string, symbol: string): Drawing[] {
  try {
    return parseDrawings(JSON.parse(localStorage.getItem(drawingStorageKey(ownerId,datasetName,symbol)) || "[]"));
  } catch { return []; }
}

export function restoreStoredDrawings(ownerId: string, datasetName: string, symbol: string, drawings: Drawing[]): void {
  localStorage.setItem(drawingStorageKey(ownerId,datasetName,symbol), JSON.stringify(parseDrawings(drawings)));
}
