import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import TradingChart from "./components/TradingChart";
import InstrumentDetails from "./components/InstrumentDetails";
import SaveStatePanel from "./components/SaveStatePanel";
import WorkspaceDrawer from "./components/WorkspaceDrawer";
import { ReplayLedger } from "./lib/replayLedger";
import {
  createSlot, drawingStorageKey, fetchCloudStates, saveCloudState,
  listLocalSaves, putLocalSave, removeLocalSave, deleteCloudState,
  mergedSaves, makeDatasetIdentity, snapshotsMatch, isSnapshot,
  readStoredDrawings, restoreStoredDrawings, type DatasetIdentity,
  type SaveSlot, type SaveStateSnapshot
} from "./lib/saveStates";
import { parseCtraderCsv } from "./lib/csv";
import { aggregateCandles, upperBoundTime, TIMEFRAME_SECONDS } from "./lib/timeframes";
import {
  advanceAccount,
  closePosition,
  initialAccount,
  metrics,
  openPosition,
  positionRawPnl,
  quote,
  marginForOrder
} from "./lib/account";
import { downloadCsvArchive, listCloudDatasets, saveCsvArchive, type CloudDataset } from "./lib/cloud";
import { supabase, supabaseConfigured } from "./lib/supabase";
import { DEFAULT_INSTRUMENT, instrumentFromImport, USOIL_S } from "./lib/instruments";
import type {
  AccountConfig,
  Candle,
  InstrumentSpec,
  Side,
  Timeframe
} from "./types";

const timeframes: Timeframe[] = ["M1", "M5", "M15", "M30", "H1", "H4", "D1"];

const defaultAccount: AccountConfig = {
  currency: "USD",
  initialBalance: 100,
  leverage: 100,
  marginCallLevel: 100,
  stopOutLevel: 50
};

const defaultInstrument: InstrumentSpec = DEFAULT_INSTRUMENT;

const money = (value: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const price = (value: number | undefined) =>
  value === undefined ? "—" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 }).format(value);

function dateTime(seconds: number | undefined) {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 19);
}

function preferredReplayIndex(candles: Candle[]): number {
  if (!candles.length) return 0;
  const year2026 = Date.UTC(2026, 0, 1) / 1000;
  const first2026 = upperBoundTime(candles, year2026 - 1);
  if (first2026 < candles.length) return first2026;
  return Math.max(0, candles.length - 251);
}

export default function App() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [baseCandles, setBaseCandles] = useState<Candle[]>([]);
  const [datasetName, setDatasetName] = useState("FxPro cTrader import");
  const [timeframe, setTimeframe] = useState<Timeframe>("M15");
  const [replayIndex, setReplayIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [accountConfig, setAccountConfig] = useState<AccountConfig>(defaultAccount);
  const [instrument, setInstrument] = useState<InstrumentSpec>(defaultInstrument);
  const [account, setAccount] = useState(() => initialAccount(defaultAccount));
  const [lots, setLots] = useState(0.01);
  const [stopLoss, setStopLoss] = useState("");
  const [takeProfit, setTakeProfit] = useState("");
  const [status, setStatus] = useState("Import an M1 CSV exported from cTrader.");
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authFeedback, setAuthFeedback] = useState("");
  const [cloudProgress, setCloudProgress] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cloudDatasets, setCloudDatasets] = useState<CloudDataset[]>([]);
  const [cloudBusy, setCloudBusy] = useState(false);
  const uploadingFileRef = useRef<File | null>(null);
  const savedFileRef = useRef<File | null>(null);

  const [datasetIdentity, setDatasetIdentity] = useState<DatasetIdentity | null>(null);
  const [accountName, setAccountName] = useState("Account 1");
  const [saveName, setSaveName] = useState("WTI backtest");
  const [saveSlots, setSaveSlots] = useState<SaveSlot[]>([]);
  const [saveStatus, setSaveStatus] = useState("");
  const [saveBusy, setSaveBusy] = useState(false);
  const [openPanel, setOpenPanel] = useState<"saved" | "library" | null>(null);
  const [mobileView, setMobileView] = useState<"chart" | "trade" | "history">("chart");
  const [blotterTab, setBlotterTab] = useState<"open" | "closed">("open");
  const [seekTarget, setSeekTarget] = useState(0);
  const [seeking, setSeeking] = useState(false);
  const seekingRef = useRef(false);
  const ledgerRef = useRef<ReplayLedger | null>(null);
  const [drawingGeneration, setDrawingGeneration] = useState(0);
  const snapshotRef = useRef<SaveStateSnapshot | null>(null);
  const cloudSavingRef = useRef(false);
  const cloudQueueRef = useRef<SaveSlot[]>([]);
  const restoringRef = useRef(false);
  const autosaveIdRef = useRef<string | null>(null);
  const ownerId = session?.user.id ?? "guest";

  const aggregated = useMemo(
    () => (baseCandles.length ? aggregateCandles(baseCandles, timeframe) : []),
    [baseCandles, timeframe]
  );

  useEffect(() => setSeekTarget(replayIndex), [replayIndex]);
  const currentCandle = baseCandles[replayIndex];
  const currentTime = currentCandle?.time ?? 0;
  const visibleAggregated = useMemo(() => {
    if (!currentTime) return [];
    const end = upperBoundTime(aggregated, currentTime);
    // Render only a window around the current replay point.
    const window = aggregated.slice(Math.max(0, end - 1600), end);
    if (!window.length || timeframe === "M1") return window;

    // IMPORTANT: don't leak the future OHLC of the current incomplete
    // M5/H1/H4/D1 candle. Rebuild it from M1 only up to replayIndex.
    const interval = TIMEFRAME_SECONDS[timeframe];
    const startTime = Math.floor(currentTime / interval) * interval;
    const firstM1 = upperBoundTime(baseCandles, startTime - 1);
    const current = baseCandles[replayIndex];
    if (!current || window[window.length - 1].time !== startTime || firstM1 > replayIndex) return window;
    const partial = {
      time: startTime,
      open: baseCandles[firstM1].open,
      high: -Infinity, low: Infinity,
      close: current.close, volume: 0
    };
    for (let i = firstM1; i <= replayIndex; i += 1) {
      partial.high = Math.max(partial.high, baseCandles[i].high);
      partial.low = Math.min(partial.low, baseCandles[i].low);
      partial.volume += baseCandles[i].volume;
    }
    return [...window.slice(0, -1), partial];
  }, [aggregated, currentTime, replayIndex, baseCandles, timeframe]);

  const accountMetrics = useMemo(
    () =>
      currentCandle
        ? metrics(account, currentCandle.close, accountConfig, instrument)
        : metrics(account, 0, accountConfig, instrument),
    [account, currentCandle, accountConfig, instrument]
  );

  const buyMargin = currentCandle
    ? marginForOrder("buy", lots, currentCandle.close, accountConfig, instrument) : 0;
  const sellMargin = currentCandle
    ? marginForOrder("sell", lots, currentCandle.close, accountConfig, instrument) : 0;
  const estimatedSpreadCost = currentCandle
    ? (quote(currentCandle.close, instrument).ask - quote(currentCandle.close, instrument).bid)
      * instrument.contractSize * lots : 0;

  const marginWarning =
    accountMetrics.marginLevel !== null && accountMetrics.marginLevel <= accountConfig.marginCallLevel;

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  const stepOnce = useCallback(() => {
    const ledger = ledgerRef.current;
    if (!ledger || seekingRef.current || !baseCandles.length) return;
    if (ledger.index >= baseCandles.length - 1) {
      setPlaying(false);
      return;
    }
    ledger.advanceOne(baseCandles, accountConfig, instrument);
    setAccount(ledger.account);
    setReplayIndex(ledger.index);
  }, [baseCandles, accountConfig, instrument]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(stepOnce, Math.max(40, 1000 / speed));
    return () => window.clearInterval(timer);
  }, [playing, speed, stepOnce]);

  async function onImport(file: File, autoArchive = true) {
    setPlaying(false);
    setStatus("Parsing " + file.name + "…");
    try {
      const candles = await parseCtraderCsv(file, (progress) => {
        setStatus("Reading " + progress.rows.toLocaleString() + " candles · " +
          Math.min(100, Math.floor(progress.fraction * 100)) + "%");
      });
      const start = preferredReplayIndex(candles);
      const name = file.name.replace(/\.csv$/i, "");
      setDatasetIdentity(makeDatasetIdentity(file, candles, name));
      setBaseCandles(candles);
      setDatasetName(name);
      setReplayIndex(start);
      const openingAccount = initialAccount(accountConfig);
      ledgerRef.current = new ReplayLedger(start, openingAccount);
      setAccount(openingAccount);
      setMobileView("chart");
      const spec = instrumentFromImport(file.name);
      setInstrument(spec);
      setLots(spec.minLot);
      setStopLoss("");
      setTakeProfit("");
      savedFileRef.current = autoArchive ? null : file;
      setPendingFile(autoArchive ? file : null);
      if (autoArchive) {
        setCloudProgress(session
          ? "CSV parsed. Automatically backing up to Supabase…"
          : "Local import loaded. Sign in to automatically save it to Supabase.");
      }
      setStatus(
        candles.length.toLocaleString() +
          " M1 candles loaded. " +
          dateTime(candles[0].time) +
          " → " +
          dateTime(candles[candles.length - 1].time)
      );
      return candles;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "CSV import failed.");
      return null;
    }
  }

  function resetAccount() {
    if ((account.positions.length || account.history.length) &&
      !window.confirm("Reset this account? Open and closed trades will be cleared. Save a checkpoint first.")) return;
    setPlaying(false);
    const reset = initialAccount(accountConfig);
    ledgerRef.current?.reset(replayIndex, reset);
    setAccount(reset);
    setStatus("Trading account reset to initial balance.");
  }

  function confirmReplaceDataset(): boolean {
    if (!account.positions.length && !account.history.length) return true;
    return window.confirm("Opening a different CSV resets the current trading account. Save this session first?");
  }

  /** Time travel restores the ledger instead of clearing the account. */
  async function moveReplay(targetIndex: number) {
    const ledger = ledgerRef.current;
    if (!ledger || seekingRef.current || !baseCandles.length) return;
    const target = Math.max(0, Math.min(baseCandles.length - 1, Math.floor(targetIndex)));
    if (target === ledger.index) return;
    setPlaying(false);
    seekingRef.current = true;
    setSeeking(true);
    setStatus("Moving replay and recalculating simulated positions…");
    try {
      const result = await ledger.seek(target, baseCandles, accountConfig, instrument,
        (done, total) => {
          if (total > 2500) {
            setStatus("Rebuilding M1 account history: " +
              Math.round(done * 100 / total) + "%");
          }
        });
      setAccount(result.account);
      setReplayIndex(result.index);
      setSeekTarget(result.index);
      setStatus(result.undone
        ? "Replay moved backward: future trade entries and exits undone. Continue trading from this candle."
        : "Replay moved to " + dateTime(baseCandles[result.index].time) +
          " UTC. Existing positions and realized trades preserved; floating P/L recalculated.");
    } catch (error) {
      setStatus("Replay navigation failed; your account was not reset: " +
        (error instanceof Error ? error.message : String(error)));
    } finally {
      seekingRef.current = false;
      setSeeking(false);
    }
  }

  function jumpToStart() {
    void moveReplay(preferredReplayIndex(baseCandles));
  }

  function applySeek(index: number) {
    void moveReplay(index);
  }

  function jumpToDate(value: string) {
    if (!value || !baseCandles.length) return;
    const utc = Date.parse(value + "T00:00:00Z") / 1000;
    if (!Number.isFinite(utc)) return;
    const index = Math.min(baseCandles.length - 1, upperBoundTime(baseCandles, utc - 1));
    void moveReplay(index);
  }

  function place(side: Side) {
    if (!currentCandle || seekingRef.current) return;
    const ledger = ledgerRef.current;
    if (!ledger) return;
    const result = openPosition(
      ledger.account,
      side,
      lots,
      currentCandle.close,
      currentCandle.time,
      accountConfig,
      instrument,
      stopLoss ? Number(stopLoss) : undefined,
      takeProfit ? Number(takeProfit) : undefined
    );
    if (result.error) {
      setStatus(result.error);
      return;
    }
    ledger.recordAction(result.state);
    setAccount(result.state);
    setStatus(side.toUpperCase() + " " + lots + " lot opened.");
  }

  function close(id: string) {
    if (!currentCandle || seekingRef.current) return;
    const ledger = ledgerRef.current;
    if (!ledger || !ledger.account.positions.some((position) => position.id === id)) return;
    const next = closePosition(
      ledger.account, id, currentCandle.close, currentCandle.time, instrument, "manual"
    );
    ledger.recordAction(next);
    setAccount(next);
  }

  async function auth(mode: "signin" | "signup") {
    if (!supabase) return;
    setAuthFeedback("Connecting…");
    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    const message = result.error ? result.error.message : mode === "signin"
      ? "Signed in. Your cloud library is ready."
      : "Account created. Verify your email if confirmation is enabled.";
    setAuthFeedback(message);
    setStatus(message);
  }

  const refreshCloud = useCallback(async () => {
    if (!supabase) return;
    try {
      const results = await listCloudDatasets();
      setCloudDatasets(results);
    } catch (error) {
      setCloudProgress(error instanceof Error ? error.message : "Could not list saved datasets.");
    }
  }, []);

  useEffect(() => {
    if (session) void refreshCloud();
    else setCloudDatasets([]);
  }, [session?.user.id, refreshCloud]);

  const persistFile = useCallback(async (file: File) => {
    if (!session || !baseCandles.length) return;
    if (uploadingFileRef.current || savedFileRef.current === file) return;
    uploadingFileRef.current = file;
    setCloudBusy(true);
    setCloudProgress("Preparing secure cloud backup…");
    try {
      const id = await saveCsvArchive({
        file,
        name: file.name.replace(/\.csv$/i, ""),
        symbol: instrument.symbol,
        candles: baseCandles,
        instrument,
        onProgress: (done, total) => {
          setCloudProgress("Saving to Supabase: " + Math.round(done / total * 100) +
            "% (" + done + "/" + total + " compressed chunks). Keep this tab open.");
        }
      });
      savedFileRef.current = file;
      setDatasetIdentity((previous) =>
        previous && previous.fileName === file.name && previous.sizeBytes === file.size
          ? { ...previous, cloudDatasetId: id }
          : previous);
      setCloudProgress("Saved to Supabase successfully · " + id.slice(0, 8) +
        ". Available when you sign in on another device.");
      await refreshCloud();
    } catch (error) {
      setCloudProgress("Cloud backup failed: " +
        (error instanceof Error ? error.message : String(error)) +
        ". Use Retry cloud backup while signed in.");
    } finally {
      uploadingFileRef.current = null;
      setCloudBusy(false);
    }
  }, [session?.user.id, baseCandles, instrument, refreshCloud]);

  useEffect(() => {
    if (!session || !pendingFile || !baseCandles.length) return;
    if (savedFileRef.current === pendingFile || uploadingFileRef.current) return;
    void persistFile(pendingFile);
  }, [session?.user.id, pendingFile, baseCandles, persistFile]);

  async function openCloudDataset(dataset: CloudDataset) {
    if (cloudBusy) return;
    setPlaying(false);
    setCloudBusy(true);
    setCloudProgress("Opening " + dataset.name + " from Supabase…");
    try {
      const file = await downloadCsvArchive(dataset, (done, total) => {
        setCloudProgress("Downloading " + Math.round(done / total * 100) +
          "% (" + done + "/" + total + " compressed chunks)");
      });
      const loaded = await onImport(file, false);
      if (!loaded) throw new Error("Could not read the restored dataset.");
      setDatasetIdentity(makeDatasetIdentity(file, loaded, dataset.name, dataset.id));
      setDatasetName(dataset.name);
      const preset = instrumentFromImport(dataset.original_file_name || dataset.name, dataset.symbol);
      // Older WTI cloud archives may contain the old generic XAU settings.
      // Always restore the broker's non-negotiable USOIL.S volume/tick properties.
      const spec = preset.symbol === "USOIL.S" ? {
        ...USOIL_S,
        ...(dataset.instrument?.symbol === "USOIL.S"
          ? { spread: dataset.instrument.spread, commissionPerLotRoundTurn: dataset.instrument.commissionPerLotRoundTurn,
              serverUtcOffsetHours: dataset.instrument.serverUtcOffsetHours,
              swapRolloverUtcHour: dataset.instrument.swapRolloverUtcHour }
          : {})
      } : (dataset.instrument ?? preset);
      setInstrument(spec);
      setLots(spec.minLot);
      setCloudProgress("Restored " + dataset.name + " from Supabase.");
      setOpenPanel(null);
      setMobileView("chart");
    } catch (error) {
      setStatus("Could not open cloud dataset. Check the Cloud & datasets panel.");
      setCloudProgress("Failed to open cloud dataset: " +
        (error instanceof Error ? error.message : String(error)));
    } finally {
      setCloudBusy(false);
    }
  }


  const refreshSaves = useCallback(async () => {
    const local = listLocalSaves(ownerId);
    setSaveSlots(local);
    if (!session) return;
    try {
      const remote = await fetchCloudStates(session.user.id);
      setSaveSlots(mergedSaves(listLocalSaves(ownerId), remote));
    } catch (error) {
      setSaveStatus("Cloud save list unavailable; local checkpoints are still accessible: " +
        (error instanceof Error ? error.message : String(error)));
    }
  }, [ownerId, session?.user.id]);

  useEffect(() => {
    autosaveIdRef.current = null;
    void refreshSaves();
  }, [ownerId, refreshSaves]);

  // Never snapshot the millions of candles. Only their immutable identity,
  // replay clock, account ledger and small drawing metadata.
  const currentSnapshot = useMemo<SaveStateSnapshot | null>(() => {
    if (!datasetIdentity || !currentCandle) return null;
    return {
      version: 1,
      dataset: datasetIdentity,
      accountName: accountName.trim() || "Account 1",
      replayIndex, replayTime: currentCandle.time,
      timeframe, speed, accountConfig, instrument, account,
      ticket: { lots, stopLoss, takeProfit },
      drawings: [],
      savedAt: new Date().toISOString()
    };
  }, [datasetIdentity, currentCandle?.time, accountName, replayIndex, timeframe, speed,
    accountConfig, instrument, account, lots, stopLoss, takeProfit]);

  snapshotRef.current = currentSnapshot;

  const captureSnapshot = useCallback((): SaveStateSnapshot | null => {
    if (seekingRef.current) return null; // never persist an in-progress seek
    const snapshot = snapshotRef.current;
    if (!snapshot) return null;
    return { ...snapshot,
      replayLedger: ledgerRef.current?.exportSave(),
      drawings: readStoredDrawings(ownerId, snapshot.dataset.name, snapshot.instrument.symbol),
      savedAt: new Date().toISOString()
    };
  }, [ownerId]);

  const saveCheckpoint = useCallback(async (kind: "auto" | "manual", name?: string, replaceId?: string) => {
    if (restoringRef.current) return;
    const snapshot = captureSnapshot();
    if (!snapshot) {
      setSaveStatus("Import or open a dataset before saving a backtest.");
      return;
    }
    const id = kind === "auto" ?
      (autosaveIdRef.current ?? listLocalSaves(ownerId).find((slot) => slot.kind === "auto")?.id ?? crypto.randomUUID()) :
      (replaceId ?? crypto.randomUUID());
    if (kind === "auto") autosaveIdRef.current = id;
    const slot = createSlot(snapshot,
      kind === "auto" ? "Latest automatic checkpoint" : (name || saveName),
      kind, id);

    try {
      putLocalSave(ownerId, slot);
      setSaveSlots((previous) => mergedSaves([slot], previous.filter((item) => item.id !== slot.id)));
      if (kind === "manual") setSaveStatus("Saved locally. Preparing cloud sync…");
    } catch (error) {
      setSaveStatus("Device backup failed: " +
        (error instanceof Error ? error.message : String(error)) + ". Try deleting older named saves.");
      return;
    }

    if (session?.user.id && slot.snapshot.dataset.cloudDatasetId) {
      if (cloudSavingRef.current) {
        if (kind === "manual") {
          cloudQueueRef.current.push(slot);
          setSaveStatus("Saved locally; cloud backup queued behind the current sync.");
        }
        return;
      }
      cloudSavingRef.current = true;
      try {
        await saveCloudState(session.user.id, slot);
        while (cloudQueueRef.current.length) {
          const pending = cloudQueueRef.current.shift()!;
          await saveCloudState(session.user.id, pending);
        }
        if (kind === "manual" || cloudQueueRef.current.length === 0) {
          setSaveStatus("Backtest state synced to this device and Supabase.");
        }
      } catch (error) {
        setSaveStatus("Saved on device, but Supabase sync failed: " +
          (error instanceof Error ? error.message : String(error)));
      } finally {
        cloudSavingRef.current = false;
      }
    } else if (kind === "manual") {
      setSaveStatus("Saved on this device. For cross-device resume, sign in and finish the Supabase CSV backup.");
    }
  }, [captureSnapshot, ownerId, session?.user.id, saveName]);

  // Passive local autosave every 20 seconds; slower cloud checkpoint cadence
  // limits requests during accelerated replay.
  const tickSaveRef = useRef(saveCheckpoint);
  tickSaveRef.current = saveCheckpoint;
  useEffect(() => {
    if (!datasetIdentity) return;
    let ticks = 0;
    const timer = window.setInterval(() => {
      if (restoringRef.current || cloudBusy) return;
      ticks += 1;
      if (ticks % 3 === 0) {
        void tickSaveRef.current("auto");
      } else {
        // Locally checkpoint every 20 seconds without uploading continuously.
        const snapshot = captureSnapshot();
        if (!snapshot) return;
        const id = autosaveIdRef.current ?? listLocalSaves(ownerId).find((slot) => slot.kind === "auto")?.id ?? crypto.randomUUID();
        autosaveIdRef.current = id;
        try {
          const slot = createSlot(snapshot, "Latest automatic checkpoint", "auto", id);
          putLocalSave(ownerId, slot);
          setSaveSlots((previous) => mergedSaves([slot], previous.filter((entry) => entry.id !== id)));
        } catch (error) {
          setSaveStatus("Local auto-save failed: " + String(error));
        }
      }
    }, 20000);
    return () => window.clearInterval(timer);
  }, [datasetIdentity?.key, ownerId, captureSnapshot, cloudBusy]);

  // Best-effort synchronous local checkpoint on page/tab close; no cloud claim.
  useEffect(() => {
    const onHide = () => {
      if (restoringRef.current) return;
      const snapshot = captureSnapshot();
      if (!snapshot) return;
      try {
        const id = autosaveIdRef.current ?? crypto.randomUUID();
        autosaveIdRef.current = id;
        putLocalSave(ownerId, createSlot(snapshot, "Latest automatic checkpoint", "auto", id));
      } catch { /* Browser may deny storage on shutdown; periodic saves remain. */ }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [captureSnapshot, ownerId]);

  async function restoreSlot(slot: SaveSlot) {
    if (!isSnapshot(slot.snapshot)) {
      setSaveStatus("This save state has an unsupported or damaged format.");
      return;
    }
    if (saveBusy) return;
    setPlaying(false);
    setSaveBusy(true);
    restoringRef.current = true;
    try {
      const saved = slot.snapshot;
      let loadedIdentity = datasetIdentity;
      let candles = baseCandles;
      if (!snapshotsMatch(loadedIdentity, saved.dataset)) {
        const sourceId = saved.dataset.cloudDatasetId;
        if (!sourceId || !session) {
          throw new Error("The matching source CSV is not open. Import " +
            saved.dataset.fileName + " first, then click Resume again.");
        }
        setSaveStatus("Restoring historical candles from Supabase…");
        const files = await listCloudDatasets();
        const source = files.find((entry) => entry.id === sourceId);
        if (!source) throw new Error("The saved source CSV is not available in your Supabase library.");
        const file = await downloadCsvArchive(source, (done, total) =>
          setSaveStatus("Downloading source CSV: " + Math.round(100 * done / total) + "%"));
        // Parse without modifying the current account or loaded dataset. Validation
        // must complete before the state transition, or an invalid source would
        // destructively reset an ongoing backtest.
        const parsed = await parseCtraderCsv(file, (progress) =>
          setSaveStatus("Reading restored M1 data: " + Math.round(100 * progress.fraction) + "%"));
        candles = parsed;
        loadedIdentity = makeDatasetIdentity(file, parsed, saved.dataset.name, sourceId);
      }
      if (!snapshotsMatch(loadedIdentity, saved.dataset)) {
        throw new Error("Dataset identity mismatch. Open the original CSV to restore this checkpoint safely.");
      }
      const correctIndex = candles[saved.replayIndex]?.time === saved.replayTime
        ? saved.replayIndex
        : upperBoundTime(candles, saved.replayTime) - 1;
      if (correctIndex < 0 || candles[correctIndex]?.time !== saved.replayTime) {
        throw new Error("Saved replay candle is absent from this dataset. Account state left unchanged.");
      }

      // All checks passed. Swap source candles and ledger together; no future-price
      // replay steps are executed while changing the save slot.
      if (candles !== baseCandles) {
        setBaseCandles(candles);
        setPendingFile(null);
      }
      // Make drawing snapshot available before remounting TradingChart.
      restoreStoredDrawings(ownerId, saved.dataset.name, saved.instrument.symbol, saved.drawings);
      setDatasetName(saved.dataset.name);
      if (!loadedIdentity) throw new Error("No source dataset available for restore.");
      setDatasetIdentity({ ...loadedIdentity, cloudDatasetId: saved.dataset.cloudDatasetId || loadedIdentity.cloudDatasetId });
      ledgerRef.current = ReplayLedger.fromSave(correctIndex, saved.account, saved.replayLedger);
      setReplayIndex(correctIndex);
      setTimeframe(saved.timeframe);
      setSpeed(saved.speed);
      setAccountConfig(saved.accountConfig);
      setInstrument(saved.instrument);
      setAccount(saved.account);
      setLots(saved.ticket.lots);
      setStopLoss(saved.ticket.stopLoss);
      setTakeProfit(saved.ticket.takeProfit);
      setAccountName(saved.accountName);
      setSaveName(slot.kind === "manual" ? slot.name : saved.accountName + " checkpoint");
      setDrawingGeneration((n) => n + 1);
      setSaveStatus("Resumed " + slot.name + " at " +
        new Date(saved.replayTime * 1000).toISOString().replace("T", " ").slice(0, 16) +
        " UTC. Replay is paused; account and orders restored.");
      setStatus("Restored named backtest session: " + slot.name);
      setMobileView("chart");
      setOpenPanel(null);
    } catch (error) {
      setSaveStatus("Restore unavailable: " +
        (error instanceof Error ? error.message : String(error)));
    } finally {
      setSaveBusy(false);
      window.setTimeout(() => { restoringRef.current = false; }, 1000);
    }
  }

  async function deleteSlot(slot: SaveSlot) {
    if (!window.confirm("Delete '" + slot.name + "'? This cannot be undone.")) return;
    setSaveBusy(true);
    try {
      if (session) await deleteCloudState(session.user.id, slot.id);
      removeLocalSave(ownerId, slot.id);
      setSaveSlots((previous) => previous.filter((entry) => entry.id !== slot.id));
      setSaveStatus("Deleted " + slot.name + ".");
    } catch (error) {
      setSaveStatus("Could not delete save: " + String(error));
    } finally {
      setSaveBusy(false);
    }
  }

  function newAccount() {
    if (!datasetIdentity || !window.confirm(
      "Start another simulated account at this candle? Save the current account as a named slot first."
    )) return;
    setPlaying(false);
    const nextAccount = initialAccount(accountConfig);
    ledgerRef.current?.reset(replayIndex, nextAccount);
    setAccount(nextAccount);
    setAccountName("Account " + Math.floor(Date.now() / 1000).toString().slice(-5));
    setSaveStatus("New trading account started. Use Save now to preserve it separately.");
  }

  const updateAccount = (key: keyof AccountConfig, value: string) => {
    if (account.positions.length) {
      setStatus("Close the open position before changing leverage or account settings.");
      return;
    }
    ledgerRef.current?.reset(replayIndex, account);
    setAccountConfig((prev) => ({ ...prev, [key]: key === "currency" ? value : Number(value) }));
  };

  const updateInstrument = (key: keyof InstrumentSpec, value: string) => {
    if (account.positions.length) {
      setStatus("Close all trades before changing instrument contract or execution assumptions.");
      return;
    }
    ledgerRef.current?.reset(replayIndex, account);
    setInstrument((prev) => ({
      ...prev,
      [key]: key === "symbol" ? value
        : key === "serverUtcOffsetHours" && value === "" ? null : Number(value)
    }));
  };

  return (
    <main className="app" data-mobile-view={mobileView}>
      <header className="topbar">
        <div className="brand" aria-label="Calyze historical trading terminal">
          <span className="brand-mark" aria-hidden="true">C</span>
          <div>
            <strong>Calyze</strong>
            <small>REPLAY TERMINAL</small>
          </div>
        </div>
        <div className="header-context" title={status}>
          <span className="header-context-label">{baseCandles.length ? instrument.symbol : "Historical analysis"}</span>
          <span>{baseCandles.length ? datasetName : "Offline-first · No live market feed"}</span>
        </div>
        <nav className="top-actions" aria-label="Workspace actions">
          <button className="header-action" onClick={() => fileRef.current?.click()}
            title="Import cTrader M1 historical CSV">
            <span aria-hidden="true">↑</span> Import
          </button>
          <button className="header-action" onClick={() => setOpenPanel("saved")}
            aria-label={"Open saved backtests, " + saveSlots.length + " available"}>
            <span aria-hidden="true">▣</span> Saves
            {saveSlots.length > 0 && <span className="action-count">{saveSlots.length}</span>}
          </button>
          <button className="header-action" onClick={() => setOpenPanel("library")}
            title="Supabase cloud library and authentication">
            <span className={"sync-indicator " + (session ? "online" : "")} aria-hidden="true" />
            {cloudBusy ? "Syncing" : session ? "Library" : "Cloud"}
          </button>
        </nav>
        <input ref={fileRef} hidden type="file" accept=".csv,text/csv"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file && confirmReplaceDataset()) {
              setOpenPanel(null);
              void onImport(file);
            }
            event.target.value = "";
          }} />
      </header>

      {baseCandles.length > 0 && (
        <>
          <section className="workspace-stats" aria-label="Simulated account summary">
            <div className="workspace-stat"><span>Account</span><strong>{accountName}</strong></div>
            <div className="workspace-stat"><span>Balance</span><strong>{accountConfig.currency} {money(accountMetrics.balance)}</strong></div>
            <div className="workspace-stat"><span>Equity</span>
              <strong className={accountMetrics.equity < accountMetrics.balance ? "negative" : "positive"}>
                {money(accountMetrics.equity)}
              </strong>
            </div>
            <div className="workspace-stat"><span>Free margin</span><strong>{money(accountMetrics.freeMargin)}</strong></div>
            <div className="workspace-stat"><span>Margin level</span>
              <strong className={marginWarning ? "caution" : ""}>
                {accountMetrics.marginLevel === null ? "—" : money(accountMetrics.marginLevel) + "%"}
              </strong>
            </div>
            <div className="workspace-stat stat-time"><span>Replay · UTC</span>
              <strong>{dateTime(currentTime)}</strong>
            </div>
          </section>
          <nav className="mobile-workspace-nav" aria-label="Mobile workspace">
            <button aria-pressed={mobileView === "chart"} className={mobileView === "chart" ? "selected" : ""}
              onClick={() => setMobileView("chart")}>▤ <span>Chart</span></button>
            <button aria-pressed={mobileView === "trade"} className={mobileView === "trade" ? "selected" : ""}
              onClick={() => setMobileView("trade")}>⇅ <span>Trade</span></button>
            <button aria-pressed={mobileView === "history"} className={mobileView === "history" ? "selected" : ""}
              onClick={() => { setBlotterTab("closed"); setMobileView("history"); }}>▦ <span>History</span></button>
          </nav>
        </>
      )}

      {status && status !== "Import an M1 CSV exported from cTrader." && (
        <div className="workspace-feedback" role="status" title={status}>
          <span aria-hidden="true">●</span> {status}
        </div>
      )}

      {openPanel === "saved" && (
        <WorkspaceDrawer title="Save states" subtitle="Resume a replay session or manage account checkpoints."
          onClose={() => setOpenPanel(null)}>
          <SaveStatePanel
            accountName={accountName} onAccountNameChange={setAccountName}
            saveName={saveName} onSaveNameChange={setSaveName}
            slots={saveSlots} hasDataset={Boolean(datasetIdentity)}
            cloudReady={Boolean(session && datasetIdentity?.cloudDatasetId)}
            busy={saveBusy} status={saveStatus}
            onSave={() => void saveCheckpoint("manual", saveName)}
            onNewAccount={newAccount}
            onResume={(slot) => void restoreSlot(slot)}
            onOverwrite={(slot) => void saveCheckpoint("manual", slot.name, slot.id)}
            onDelete={(slot) => void deleteSlot(slot)}
            onRefresh={() => void refreshSaves()}
          />
        </WorkspaceDrawer>
      )}

      {openPanel === "library" && (
        <WorkspaceDrawer title="Cloud & datasets"
          subtitle="Import, store and reopen historical market data across your devices."
          onClose={() => setOpenPanel(null)}>
          {!supabaseConfigured ? (
            <p className="drawer-explainer">Cloud storage is not configured. Local CSV imports and save states remain available on this device.</p>
          ) : session ? (
            <>
              <div className="drawer-account">
                <span>Signed in as <strong>{session.user.email}</strong></span>
                <button className="ghost" onClick={() => supabase?.auth.signOut()}>Sign out</button>
              </div>
              <div className="drawer-actions">
                <button onClick={() => fileRef.current?.click()}>↑ Import another CSV</button>
                <button onClick={() => void refreshCloud()}>↻ Refresh library</button>
                {pendingFile && savedFileRef.current !== pendingFile && (
                  <button disabled={cloudBusy} onClick={() => void persistFile(pendingFile)}>
                    {cloudBusy ? "Uploading…" : "Retry cloud backup"}
                  </button>
                )}
              </div>
              <div className="drawer-section-heading">
                <strong>Cloud datasets</strong>
                <span>{cloudDatasets.length} archived</span>
              </div>
              <div className="library-dataset-list">
                {cloudDatasets.map((dataset) => (
                  <button key={dataset.id} className="library-dataset" disabled={cloudBusy}
                    onClick={() => { if (confirmReplaceDataset()) void openCloudDataset(dataset); }}>
                    <span className="library-dataset-icon">▤</span>
                    <span className="library-dataset-text">
                      <strong>{dataset.symbol} · {dataset.name}</strong>
                      <small>{Number(dataset.row_count).toLocaleString()} candles ·
                        {new Date(dataset.created_at).toLocaleDateString()}</small>
                    </span>
                    <span aria-hidden="true">↗</span>
                  </button>
                ))}
                {!cloudDatasets.length && (
                  <p className="drawer-explainer">Your library is empty. Import an M1 CSV to start a cloud archive.</p>
                )}
              </div>
            </>
          ) : (
            <div className="drawer-signin">
              <p className="drawer-explainer">Sign in to save your WTI history and backtest states to Supabase.</p>
              <label>Email <input type="email" autoComplete="email" value={email}
                onChange={(e) => setEmail(e.target.value)} placeholder="Email address" /></label>
              <label>Password <input type="password" autoComplete="current-password" value={password}
                onChange={(e) => setPassword(e.target.value)} placeholder="Password" /></label>
              <div className="drawer-actions">
                <button className="primary" onClick={() => void auth("signin")}>Sign in</button>
                <button onClick={() => void auth("signup")}>Create account</button>
              </div>
              {authFeedback && <p className="drawer-progress" role="status">{authFeedback}</p>}
            </div>
          )}
          {cloudProgress && <p className="drawer-progress" role="status">{cloudProgress}</p>}
        </WorkspaceDrawer>
      )}

      {!baseCandles.length ? (
        <section className="empty-state">
          <div className="hero-card">
            <span className="eyebrow">NO LIVE DATA</span>
            <h1>Replay your own cTrader history like a market terminal.</h1>
            <p>
              Import M1 OHLC data, change timeframe, draw on the chart, replay candle-by-candle, and trade it using a leveraged MT4-style simulated account.
            </p>
            <button className="primary large" onClick={() => fileRef.current?.click()}>
              Import FxPro cTrader M1 CSV
            </button>
            <div className="feature-grid">
              <span>Replay engine</span>
              <span>Leverage & margin</span>
              <span>Manual Buy / Sell</span>
              <span>SL / TP</span>
              <span>Multi-timeframe</span>
              <span>PWA + Android + iOS</span>
            </div>
          </div>
        </section>
      ) : (
        <>
          <section className="terminal">
            <div className="chart-column">
              <div className="marketbar">
                <div className="marketbar-primary">
                  <div className="timeframes" aria-label="Chart timeframe">
                    {timeframes.map((tf) => (
                      <button key={tf} aria-pressed={tf === timeframe}
                        className={tf === timeframe ? "active" : ""}
                        onClick={() => setTimeframe(tf)}>{tf}</button>
                    ))}
                  </div>
                  <div className="replay-controls" aria-label="Replay controls">
                    <button title="Restart from first candle in 2026" aria-label="Restart replay"
                      disabled={seeking} onClick={jumpToStart}>↤</button>
                    <button title="Previous M1 candle" aria-label="Previous candle"
                      disabled={replayIndex <= 0} disabled={seeking || replayIndex <= 0}
                      onClick={() => applySeek(replayIndex - 1)}>‹</button>
                    <button className="play" aria-label={playing ? "Pause replay" : "Play replay"}
                      aria-pressed={playing} disabled={seeking} onClick={() => setPlaying((value) => !value)}>
                      {playing ? "Ⅱ Pause" : "▶ Play"}
                    </button>
                    <button title="Next M1 candle" aria-label="Next candle" onClick={stepOnce}
                      disabled={seeking || replayIndex >= baseCandles.length - 1}>›</button>
                    <label className="speed-select" title="Replay speed">
                      <span>Speed</span>
                      <select value={speed} aria-label="Replay speed"
                        onChange={(e) => setSpeed(Number(e.target.value))}>
                        {[1, 2, 4, 8, 16, 25].map((item) => (
                          <option key={item} value={item}>{item}×</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
                <div className="marketbar-secondary">
                  <label className="jump-date-control" title="Jump to historical date (resets account)">
                    Jump to
                    <input type="date"
                      min={new Date(baseCandles[0].time * 1000).toISOString().slice(0, 10)}
                      max={new Date(baseCandles[baseCandles.length - 1].time * 1000).toISOString().slice(0, 10)}
                      value={new Date(currentTime * 1000).toISOString().slice(0, 10)}
                      onChange={(event) => jumpToDate(event.target.value)} />
                  </label>
                  <label className="timeline-seek">
                    <span>{seekTarget === replayIndex ? "Timeline" : "Preview " +
                      new Date(baseCandles[seekTarget].time * 1000).toISOString().slice(0, 16).replace("T", " ")}</span>
                    <input type="range" min="0" max={baseCandles.length - 1}
                      aria-label="Preview historical candle position" value={seekTarget}
                      onChange={(event) => setSeekTarget(Number(event.target.value))} />
                  </label>
                  <button className="timeline-apply" onClick={() => applySeek(seekTarget)}
                    disabled={seeking || seekTarget === replayIndex}>{seeking ? "Moving…" : "Go"}</button>
                  <time className="clock" dateTime={new Date(currentTime * 1000).toISOString()}>
                    {dateTime(currentTime)} UTC
                  </time>
                </div>
              </div>
              <TradingChart key={datasetName + ":" + instrument.symbol + ":" + drawingGeneration}
                candles={visibleAggregated} symbol={instrument.symbol}
                tickSize={instrument.tickSize} priceDigits={instrument.digits ?? 2}
                workspaceKey={datasetName + ":" + instrument.symbol} userId={session?.user.id} />
            </div>

            <aside className="trade-panel" aria-label="Manual trading ticket">
              <div className="ticket-heading">
                <span>MANUAL ORDER</span>
                <strong>{instrument.symbol}</strong>
              </div>
              <div className="quote-card">
                <div className="quote-pair">
                  <div><span>SELL · BID</span><strong className="negative">
                    {quote(currentCandle.close, instrument).bid.toFixed(instrument.digits ?? 2)}
                  </strong></div>
                  <div><span>BUY · ASK</span><strong className="positive">
                    {quote(currentCandle.close, instrument).ask.toFixed(instrument.digits ?? 2)}
                  </strong></div>
                </div>
                <small>{timeframe} · {instrument.chartMode === "bid" ? "Bid" : "Mid"} chart ·
                  M1 {replayIndex + 1}/{baseCandles.length}</small>
              </div>

              <div className="field-row">
                <label>Lots (min {instrument.minLot}, step {instrument.lotStep})
                  <input type="number" min={instrument.minLot} max={instrument.maxLot} step={instrument.lotStep}
                    value={lots} onChange={(e) => setLots(Number(e.target.value))} />
                </label>
                <label>Leverage<input type="number" value={accountConfig.leverage} onChange={(e) => updateAccount("leverage", e.target.value)} /></label>
              </div>
              <label>Stop loss<input type="number" step={instrument.tickSize} value={stopLoss} onChange={(e) => setStopLoss(e.target.value)} placeholder="optional" /></label>
              <label>Take profit<input type="number" step={instrument.tickSize} value={takeProfit} onChange={(e) => setTakeProfit(e.target.value)} placeholder="optional" /></label>
              {instrument.stopsLevelPoints ? (
                <div className="spec-note">Minimum SL/TP distance: {instrument.stopsLevelPoints} points
                  ({(instrument.stopsLevelPoints * instrument.tickSize).toFixed(instrument.digits ?? 2)} USD)
                </div>
              ) : null}

              <div className="order-estimates">
                <div><span>Buy margin</span><strong>{money(buyMargin)} {accountConfig.currency}</strong></div>
                <div><span>Sell margin</span><strong>{money(sellMargin)} {accountConfig.currency}</strong></div>
                <div><span>Estimated spread cost</span><strong>{money(estimatedSpreadCost)} {accountConfig.currency}</strong></div>
                <small>Simulated market execution · margin estimates use current replay price</small>
              </div>
              <div className="deal-buttons">
                <button className="sell" disabled={seeking} aria-label={"Sell " + lots + " lots"} onClick={() => place("sell")}>
                  <span>SELL MARKET</span><strong>{quote(currentCandle.close, instrument).bid.toFixed(instrument.digits ?? 2)}</strong>
                </button>
                <button className="buy" disabled={seeking} aria-label={"Buy " + lots + " lots"} onClick={() => place("buy")}>
                  <span>BUY MARKET</span><strong>{quote(currentCandle.close, instrument).ask.toFixed(instrument.digits ?? 2)}</strong>
                </button>
              </div>

              <button className="view-open-orders" onClick={() => {
                setBlotterTab("open");
                setMobileView("history");
              }}>
                View open positions ({account.positions.length}) →
              </button>

              <div className={"account-metrics " + (marginWarning ? "warning" : "")}>
                <Metric label="Balance" value={money(accountMetrics.balance)} />
                <Metric label="Equity" value={money(accountMetrics.equity)} />
                <Metric label="Floating incl. swaps" value={money(accountMetrics.floatingPnl)} />
                <Metric label="Margin" value={money(accountMetrics.usedMargin)} />
                <Metric label="Free margin" value={money(accountMetrics.freeMargin)} />
                <Metric label="Margin level" value={accountMetrics.marginLevel === null ? "∞" : money(accountMetrics.marginLevel) + "%"} />
                <Metric label="Open swap" value={money(accountMetrics.swaps)} />
              </div>

              <details>
                <summary>Account settings</summary>
                <div className="settings-grid">
                  <label>Initial balance<input type="number" value={accountConfig.initialBalance} onChange={(e) => updateAccount("initialBalance", e.target.value)} /></label>
                  <label>Margin call %<input type="number" value={accountConfig.marginCallLevel} onChange={(e) => updateAccount("marginCallLevel", e.target.value)} /></label>
                  <label>Stop-out %<input type="number" value={accountConfig.stopOutLevel} onChange={(e) => updateAccount("stopOutLevel", e.target.value)} /></label>
                  <label>Currency<input type="text" value={accountConfig.currency} readOnly /></label>
                </div>
                <button className="ghost full" onClick={resetAccount}>Reset account</button>
              </details>

              <InstrumentDetails instrument={instrument} account={accountConfig}
                chartPrice={currentCandle.close} update={updateInstrument} />

              {supabaseConfigured && !session && (
                <button className="ghost full cloud-ticket-button" onClick={() => setOpenPanel("library")}>
                  Sync your backtests with Supabase →
                </button>
              )}
            </aside>
          </section>

          <section className="blotter" aria-label="Trading positions and closed trades">
            <div className="tabs" role="tablist" aria-label="Trade history">
              <button className={blotterTab === "open" ? "selected" : ""} role="tab"
                aria-selected={blotterTab === "open"} onClick={() => setBlotterTab("open")}>
                Open positions <span>{account.positions.length}</span>
              </button>
              <button className={blotterTab === "closed" ? "selected" : ""} role="tab"
                aria-selected={blotterTab === "closed"} onClick={() => setBlotterTab("closed")}>
                Closed trades <span>{account.history.length}</span>
              </button>
              <span className="tabs-context">{accountName} · {instrument.symbol}</span>
            </div>
            <div className="table-wrap" role="tabpanel">
              {blotterTab === "open" ? (
                <table>
                  <thead><tr>
                    <th>Side</th><th>Lots</th><th>Opened (UTC)</th><th>Entry</th>
                    <th>SL</th><th>TP</th><th>Floating P/L</th><th>Action</th>
                  </tr></thead>
                  <tbody>
                    {!account.positions.length ? (
                      <tr><td colSpan={8} className="muted">No open positions. Create a simulated order using the Trade ticket.</td></tr>
                    ) : account.positions.map((position) => (
                      <tr key={position.id}>
                        <td className={position.side}>{position.side.toUpperCase()}</td>
                        <td>{position.lots}</td>
                        <td>{dateTime(position.openTime)}</td>
                        <td>{position.openPrice.toFixed(instrument.digits ?? 2)}</td>
                        <td>{position.stopLoss === undefined ? "—" : position.stopLoss.toFixed(instrument.digits ?? 2)}</td>
                        <td>{position.takeProfit === undefined ? "—" : position.takeProfit.toFixed(instrument.digits ?? 2)}</td>
                        <td className={positionRawPnl(position,currentCandle.close,instrument) < 0 ? "negative" : "positive"}>
                          {money(positionRawPnl(position, currentCandle.close, instrument) + (position.swapAccrued ?? 0))}
                        </td>
                        <td><button className="tiny" disabled={seeking} onClick={() => close(position.id)}>Close order</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table>
                  <thead><tr>
                    <th>Side</th><th>Lots</th><th>Opened (UTC)</th><th>Closed (UTC)</th>
                    <th>Entry</th><th>Exit</th><th>Reason</th><th>Net P/L</th>
                  </tr></thead>
                  <tbody>
                    {!account.history.length ? (
                      <tr><td colSpan={8} className="muted">No closed trades yet. Your complete history will appear here.</td></tr>
                    ) : account.history.map((trade) => (
                      <tr key={trade.id}>
                        <td className={trade.side}>{trade.side.toUpperCase()}</td>
                        <td>{trade.lots}</td>
                        <td>{dateTime(trade.openTime)}</td>
                        <td>{dateTime(trade.closeTime)}</td>
                        <td>{trade.openPrice.toFixed(instrument.digits ?? 2)}</td>
                        <td>{trade.closePrice?.toFixed(instrument.digits ?? 2) ?? "—"}</td>
                        <td>{(trade.exitReason ?? "manual").replaceAll("_"," ")}</td>
                        <td className={(trade.netPnl ?? 0) < 0 ? "negative" : "positive"}>
                          {money(trade.netPnl ?? 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
