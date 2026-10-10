import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import TradingChart from "./components/TradingChart";
import InstrumentDetails from "./components/InstrumentDetails";
import { parseCtraderCsv } from "./lib/csv";
import { aggregateCandles, upperBoundTime, TIMEFRAME_SECONDS } from "./lib/timeframes";
import {
  advanceAccount,
  closePosition,
  initialAccount,
  metrics,
  openPosition,
  positionRawPnl,
  quote
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
  const [cloudProgress, setCloudProgress] = useState("");
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [cloudDatasets, setCloudDatasets] = useState<CloudDataset[]>([]);
  const [cloudBusy, setCloudBusy] = useState(false);
  const uploadingFileRef = useRef<File | null>(null);
  const savedFileRef = useRef<File | null>(null);

  const aggregated = useMemo(
    () => (baseCandles.length ? aggregateCandles(baseCandles, timeframe) : []),
    [baseCandles, timeframe]
  );

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

  const marginWarning =
    accountMetrics.marginLevel !== null && accountMetrics.marginLevel <= accountConfig.marginCallLevel;

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession));
    return () => data.subscription.unsubscribe();
  }, []);

  const stepOnce = useCallback(() => {
    setReplayIndex((index) => {
      if (!baseCandles.length || index >= baseCandles.length - 1) {
        setPlaying(false);
        return index;
      }
      const nextIndex = index + 1;
      const candle = baseCandles[nextIndex];
      setAccount((state) => advanceAccount(state, candle, accountConfig, instrument));
      return nextIndex;
    });
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
      setBaseCandles(candles);
      setDatasetName(file.name.replace(/\.csv$/i, ""));
      setReplayIndex(start);
      setAccount(initialAccount(accountConfig));
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
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "CSV import failed.");
    }
  }

  function resetAccount() {
    setPlaying(false);
    setAccount(initialAccount(accountConfig));
    setStatus("Trading account reset to initial balance.");
  }

  function jumpToStart() {
    setPlaying(false);
    const start = preferredReplayIndex(baseCandles);
    setReplayIndex(start);
    setAccount(initialAccount(accountConfig));
  }

  function jumpToDate(value: string) {
    if (!value || !baseCandles.length) return;
    const utc = Date.parse(value + "T00:00:00Z") / 1000;
    if (!Number.isFinite(utc)) return;
    const index = Math.min(baseCandles.length - 1, upperBoundTime(baseCandles, utc - 1));
    setPlaying(false);
    setReplayIndex(index);
    setAccount(initialAccount(accountConfig));
    setStatus("Replay jumped to " + dateTime(baseCandles[index].time) +
      ". Account reset to avoid future data leakage.");
  }

  function place(side: Side) {
    if (!currentCandle) return;
    const result = openPosition(
      account,
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
    setAccount(result.state);
    setStatus(side.toUpperCase() + " " + lots + " lot opened.");
  }

  function close(id: string) {
    if (!currentCandle) return;
    setAccount((state) =>
      closePosition(state, id, currentCandle.close, currentCandle.time, instrument, "manual")
    );
  }

  async function auth(mode: "signin" | "signup") {
    if (!supabase) return;
    const result =
      mode === "signin"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setStatus(result.error ? result.error.message : mode === "signin" ? "Signed in." : "Account created.");
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
      await onImport(file, false);
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
    } catch (error) {
      setCloudProgress("Failed to open cloud dataset: " +
        (error instanceof Error ? error.message : String(error)));
    } finally {
      setCloudBusy(false);
    }
  }

  const updateAccount = (key: keyof AccountConfig, value: string) =>
    setAccountConfig((prev) => ({ ...prev, [key]: key === "currency" ? value : Number(value) }));

  const updateInstrument = (key: keyof InstrumentSpec, value: string) => {
    if (account.positions.length) {
      setStatus("Close all trades before changing instrument contract or execution assumptions.");
      return;
    }
    setInstrument((prev) => ({
      ...prev,
      [key]: key === "symbol" ? value
        : key === "serverUtcOffsetHours" && value === "" ? null : Number(value)
    }));
  };

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">C</span>
          <div>
            <strong>Calyze</strong>
            <small>Historical Trading Lab</small>
          </div>
        </div>

        <div className="dataset">
          <button className="ghost" onClick={() => fileRef.current?.click()}>
            Import M1 CSV
          </button>
          <input
            ref={fileRef}
            hidden
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => e.target.files?.[0] && onImport(e.target.files[0])}
          />
          <span title={status}>{status}</span>
        </div>

        <div className="top-actions">
          {supabaseConfigured ? (
            session ? (
              <>
                <button className="ghost" onClick={() => pendingFile && void persistFile(pendingFile)}
                  disabled={!pendingFile || cloudBusy || savedFileRef.current === pendingFile}>
                  {cloudBusy ? "Syncing…" : "Retry / Save"}
                </button>
                <button className="ghost" onClick={() => supabase?.auth.signOut()}>
                  Sign out
                </button>
              </>
            ) : (
              <span className="cloud-off">Supabase ready · sign in below</span>
            )
          ) : (
            <span className="cloud-off">Local mode</span>
          )}
        </div>
      </header>

      {supabaseConfigured && !session && (
        <section className="auth-banner">
          <strong>Cloud backup</strong>
          <span>Sign in to automatically save every imported CSV and open it on other devices.</span>
          <input type="email" autoComplete="email" placeholder="Email" value={email}
            onChange={(event) => setEmail(event.target.value)} />
          <input type="password" autoComplete="current-password" placeholder="Password" value={password}
            onChange={(event) => setPassword(event.target.value)} />
          <button onClick={() => void auth("signin")}>Sign in</button>
          <button onClick={() => void auth("signup")}>Sign up</button>
        </section>
      )}

      {session && (
        <section className="cloud-shelf">
          <div className="cloud-heading">
            <strong>Supabase library · {cloudDatasets.length} dataset(s)</strong>
            <button className="ghost" onClick={() => void refreshCloud()}>Refresh</button>
            {pendingFile && savedFileRef.current !== pendingFile && !cloudBusy && (
              <button onClick={() => void persistFile(pendingFile)}>Retry cloud backup</button>
            )}
          </div>
          {cloudProgress && <div className="cloud-sync-status">{cloudProgress}</div>}
          <div className="cloud-files">
            {cloudDatasets.map((dataset) => (
              <button key={dataset.id} className="cloud-file" disabled={cloudBusy}
                onClick={() => void openCloudDataset(dataset)}>
                <strong>{dataset.symbol} · {dataset.name}</strong>
                <span>{Number(dataset.row_count).toLocaleString()} M1 candles · {new Date(dataset.created_at).toLocaleDateString()}</span>
                <small>Open from Supabase ↗</small>
              </button>
            ))}
            {!cloudDatasets.length && <span className="cloud-empty">No completed cloud backups yet. Import a CSV to begin.</span>}
          </div>
        </section>
      )}

      {!session && cloudProgress && (
        <div className="cloud-sync-status standalone">{cloudProgress}</div>
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
                <div className="timeframes">
                  {timeframes.map((tf) => (
                    <button
                      key={tf}
                      className={tf === timeframe ? "active" : ""}
                      onClick={() => setTimeframe(tf)}
                    >
                      {tf}
                    </button>
                  ))}
                </div>
                <div className="replay-controls">
                  <button onClick={jumpToStart}>↤</button>
                  <button onClick={() => replayIndex > 0 && setReplayIndex((i) => i - 1)}>‹</button>
                  <button className="play" onClick={() => setPlaying((value) => !value)}>
                    {playing ? "Pause" : "Replay"}
                  </button>
                  <button onClick={stepOnce}>›</button>
                  <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                    {[1, 2, 4, 8, 16, 25].map((item) => (
                      <option key={item} value={item}>{item}×</option>
                    ))}
                  </select>
                  <span className="clock">{dateTime(currentCandle.time)}</span>
                  <label className="jump-date-control" title="Jump to a historical date (resets account)">
                    Date
                    <input type="date"
                      min={new Date(baseCandles[0].time * 1000).toISOString().slice(0, 10)}
                      max={new Date(baseCandles[baseCandles.length - 1].time * 1000).toISOString().slice(0, 10)}
                      value={new Date(currentTime * 1000).toISOString().slice(0, 10)}
                      onChange={(event) => jumpToDate(event.target.value)} />
                  </label>
                  <input className="replay-seek" type="range" min="0"
                    max={Math.max(0, baseCandles.length - 1)} value={replayIndex}
                    title="Seek through entire historical dataset (resets open trades)"
                    onChange={(event) => {
                      setPlaying(false);
                      setReplayIndex(Number(event.target.value));
                      setAccount(initialAccount(accountConfig));
                    }} />
                </div>
              </div>
              <TradingChart candles={visibleAggregated} symbol={instrument.symbol}
                workspaceKey={datasetName + ":" + instrument.symbol} userId={session?.user.id} />
            </div>

            <aside className="trade-panel">
              <div className="quote-card">
                <small>{instrument.symbol}</small>
                <strong>{Number(currentCandle.close).toFixed(instrument.digits ?? 2)}</strong>
                <span>{timeframe} · candle {replayIndex + 1}/{baseCandles.length} · chart {instrument.chartMode === "bid" ? "BID" : "MID"}</span>
                <small className="quote-ask">Modelled ask: {quote(currentCandle.close, instrument).ask.toFixed(instrument.digits ?? 2)}</small>
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

              <div className="deal-buttons">
                <button className="sell" onClick={() => place("sell")}>SELL</button>
                <button className="buy" onClick={() => place("buy")}>BUY</button>
              </div>

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
                <details>
                  <summary>Supabase sign in</summary>
                  <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
                  <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
                  <div className="split">
                    <button className="ghost" onClick={() => auth("signin")}>Sign in</button>
                    <button className="ghost" onClick={() => auth("signup")}>Sign up</button>
                  </div>
                </details>
              )}
              {session && cloudProgress && <small className="cloud-progress">{cloudProgress}</small>}
            </aside>
          </section>

          <section className="blotter">
            <div className="tabs">
              <strong>Open positions ({account.positions.length})</strong>
              <span>Closed ({account.history.length})</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Side</th><th>Lots</th><th>Open time</th><th>Open</th><th>SL</th><th>TP</th><th>P/L</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {!account.positions.length ? (
                    <tr><td colSpan={8} className="muted">No open positions.</td></tr>
                  ) : (
                    account.positions.map((position) => (
                      <tr key={position.id}>
                        <td className={position.side}>{position.side.toUpperCase()}</td>
                        <td>{position.lots}</td>
                        <td>{dateTime(position.openTime)}</td>
                        <td>{position.openPrice.toFixed(instrument.digits ?? 2)}</td>
                        <td>{position.stopLoss === undefined ? "—" : position.stopLoss.toFixed(instrument.digits ?? 2)}</td>
                        <td>{position.takeProfit === undefined ? "—" : position.takeProfit.toFixed(instrument.digits ?? 2)}</td>
                        <td>{money(positionRawPnl(position, currentCandle.close, instrument))}</td>
                        <td><button className="tiny" onClick={() => close(position.id)}>Close</button></td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {account.history.length > 0 && (
              <div className="history-strip">
                {account.history.slice(0, 6).map((trade) => (
                  <span key={trade.id}>
                    {trade.side.toUpperCase()} {trade.lots} · {trade.exitReason} · {money(trade.netPnl ?? 0)}
                  </span>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}
