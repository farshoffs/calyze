import type { Candle, InstrumentSpec } from "../types";
import { supabase } from "./supabase";

const BUCKET = "calyze-imports";
const RAW_CHUNK_BYTES = 4 * 1024 * 1024;
const FORMAT = "gzip-chunks-v1";

export interface CloudDataset {
  id: string;
  name: string;
  symbol: string;
  row_count: number;
  source_bytes: number | null;
  original_file_name: string | null;
  storage_parts: number;
  storage_format: string;
  created_at: string;
  first_ts: string | null;
  last_ts: string | null;
  instrument: InstrumentSpec;
}

export type CloudProgress = (completed: number, total: number, stage: "upload" | "download") => void;

function requireClient() {
  if (!supabase) throw new Error("Supabase is not configured in this deployment.");
  return supabase;
}

async function requireUser() {
  const client = requireClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new Error("Sign in to Supabase before syncing your CSV.");
  return user;
}

function partPath(userId: string, datasetId: string, index: number): string {
  return userId + "/" + datasetId + "/part_" + String(index).padStart(5, "0") + ".csv.gz";
}

async function gzip(blob: Blob): Promise<Blob> {
  if (!("CompressionStream" in window)) {
    throw new Error("This browser does not support gzip compression. Please use the latest Chrome, Edge or Safari.");
  }
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<Blob> {
  if (!("DecompressionStream" in window)) {
    throw new Error("This browser does not support gzip decompression.");
  }
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).blob();
}

export async function saveCsvArchive(args: {
  file: File;
  name: string;
  symbol: string;
  candles: Candle[];
  instrument: InstrumentSpec;
  onProgress?: CloudProgress;
}): Promise<string> {
  const client = requireClient();
  const user = await requireUser();
  const total = Math.ceil(args.file.size / RAW_CHUNK_BYTES);
  if (!total) throw new Error("Cannot archive an empty CSV file.");

  const { data: dataset, error: createError } = await client
    .from("datasets")
    .insert({
      user_id: user.id,
      name: args.name,
      symbol: args.symbol,
      source: "ctrader_csv",
      base_timeframe: "M1",
      row_count: args.candles.length,
      first_ts: new Date(args.candles[0].time * 1000).toISOString(),
      last_ts: new Date(args.candles[args.candles.length - 1].time * 1000).toISOString(),
      instrument: args.instrument,
      storage_format: FORMAT,
      storage_parts: total,
      storage_state: "uploading",
      source_bytes: args.file.size,
      original_file_name: args.file.name
    })
    .select("id")
    .single();

  if (createError || !dataset) throw createError ?? new Error("Failed to create dataset record.");

  let completed = 0;
  try {
    // Each compressed part is independent. Keeping raw slices <=4 MiB avoids
    // the 50MB/file Free-plan limit and large multipart retries.
    for (let start = 0; start < total; start += 3) {
      const indices = Array.from({ length: Math.min(3, total - start) }, (_, i) => start + i);
      await Promise.all(indices.map(async (index) => {
        const from = index * RAW_CHUNK_BYTES;
        const until = Math.min(args.file.size, from + RAW_CHUNK_BYTES);
        const compressed = await gzip(args.file.slice(from, until));
        const path = partPath(user.id, dataset.id as string, index);
        const { error } = await client.storage.from(BUCKET).upload(path, compressed, {
          contentType: "application/gzip",
          upsert: false,
          cacheControl: "3600"
        });
        if (error) throw new Error("Chunk " + (index + 1) + " upload failed: " + error.message);
        completed += 1;
        args.onProgress?.(completed, total, "upload");
      }));
    }

    const { error: completeError } = await client
      .from("datasets")
      .update({ storage_state: "ready" })
      .eq("id", dataset.id)
      .eq("user_id", user.id);
    if (completeError) throw completeError;
    return dataset.id as string;
  } catch (error) {
    await client.from("datasets").update({ storage_state: "failed" }).eq("id", dataset.id);
    throw error;
  }
}

export async function listCloudDatasets(): Promise<CloudDataset[]> {
  const client = requireClient();
  const user = await requireUser();
  const { data, error } = await client
    .from("datasets")
    .select("id,name,symbol,row_count,source_bytes,original_file_name,storage_parts,storage_format,created_at,first_ts,last_ts,instrument")
    .eq("user_id", user.id)
    .eq("storage_state", "ready")
    .eq("storage_format", FORMAT)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as CloudDataset[];
}

export async function downloadCsvArchive(
  dataset: CloudDataset,
  onProgress?: CloudProgress
): Promise<File> {
  const client = requireClient();
  const user = await requireUser();
  const total = dataset.storage_parts;
  if (!Number.isInteger(total) || total <= 0) throw new Error("Invalid archive part count.");
  const parts: Blob[] = new Array(total);
  let completed = 0;

  for (let start = 0; start < total; start += 3) {
    const indices = Array.from({ length: Math.min(3, total - start) }, (_, i) => start + i);
    await Promise.all(indices.map(async (index) => {
      const path = partPath(user.id, dataset.id, index);
      const { data, error } = await client.storage.from(BUCKET).download(path);
      if (error || !data) throw new Error("Chunk " + (index + 1) + " download failed: " + (error?.message ?? "missing data"));
      parts[index] = await gunzip(data);
      completed += 1;
      onProgress?.(completed, total, "download");
    }));
  }

  return new File(parts, dataset.original_file_name || dataset.name + ".csv", {
    type: "text/csv",
    lastModified: Date.now()
  });
}
