import { describe, expect, it } from "vitest";
import { advanceAccount, closePosition, initialAccount, metrics, openPosition } from "./account";
import { ReplayLedger, validReplayLedger } from "./replayLedger";
import { USOIL_S } from "./instruments";
import type { AccountConfig, Candle } from "../types";

const cfg: AccountConfig = {
  currency: "USD", initialBalance: 1000, leverage: 500,
  marginCallLevel: 100, stopOutLevel: 50
};
const prices = [89.30, 89.34, 89.38, 89.45, 89.51, 89.58, 89.62, 89.48];
const startTime = Date.parse("2026-10-05T10:00:00Z") / 1000;
const bars: Candle[] = prices.map((close, i) => ({
  time: startTime + i * 60, open: close, close,
  high: close + 0.02, low: close - 0.02, volume: 10
}));

function buy(ledger: ReplayLedger, stopLoss?: number, takeProfit?: number) {
  const result = openPosition(ledger.account, "buy", 0.1, bars[ledger.index].close,
    bars[ledger.index].time, cfg, USOIL_S, stopLoss, takeProfit);
  expect(result.error).toBeUndefined();
  ledger.recordAction(result.state);
  return result.state.positions[0].id;
}

describe("ReplayLedger backward/forward navigation", () => {
  it("keeps the executed BUY and its entry price when looking back after entry", async () => {
    const ledger = new ReplayLedger(0, initialAccount(cfg));
    await ledger.seek(2, bars, cfg, USOIL_S);
    const id = buy(ledger);
    await ledger.seek(6, bars, cfg, USOIL_S);
    const profitAt6 = metrics(ledger.account, bars[6].close, cfg, USOIL_S).floatingPnl;
    const result = await ledger.seek(4, bars, cfg, USOIL_S);
    expect(result.undone).toBe(false);
    expect(ledger.account.positions).toHaveLength(1);
    expect(ledger.account.positions[0].id).toBe(id);
    expect(ledger.account.positions[0].openPrice).toBeCloseTo(89.41);
    const profitAt4 = metrics(ledger.account, bars[4].close, cfg, USOIL_S).floatingPnl;
    expect(profitAt4).toBeGreaterThan(0);
    expect(profitAt6).toBeGreaterThan(profitAt4);
    await ledger.seek(6, bars, cfg, USOIL_S);
    expect(ledger.account.positions[0].id).toBe(id);
    expect(metrics(ledger.account,bars[6].close,cfg,USOIL_S).floatingPnl).toBeCloseTo(profitAt6);
  });

  it("undoes the entry only when crossing before its candle; never replays future order", async () => {
    const ledger = new ReplayLedger(0, initialAccount(cfg));
    await ledger.seek(2, bars, cfg, USOIL_S);
    buy(ledger);
    await ledger.seek(6, bars, cfg, USOIL_S);
    const rollback = await ledger.seek(1, bars, cfg, USOIL_S);
    expect(rollback.undone).toBe(true);
    expect(ledger.account.positions).toHaveLength(0);
    expect(ledger.account.balance).toBe(1000);
    await ledger.seek(6, bars, cfg, USOIL_S);
    expect(ledger.account.positions).toHaveLength(0);
    expect(ledger.account.history).toHaveLength(0);
  });

  it("restores an open position after rewinding past a manual close", async () => {
    const ledger = new ReplayLedger(0, initialAccount(cfg));
    await ledger.seek(2,bars,cfg,USOIL_S);
    const id = buy(ledger);
    await ledger.seek(6,bars,cfg,USOIL_S);
    ledger.recordAction(closePosition(ledger.account,id,bars[6].close,bars[6].time,USOIL_S));
    expect(ledger.account.positions).toHaveLength(0);
    expect(ledger.account.history).toHaveLength(1);
    await ledger.seek(4,bars,cfg,USOIL_S);
    expect(ledger.account.positions[0].id).toBe(id);
    expect(ledger.account.history).toHaveLength(0);
    await ledger.seek(7,bars,cfg,USOIL_S);
    expect(ledger.account.positions).toHaveLength(1);
    expect(ledger.account.history).toHaveLength(0);
  });

  it("recomputes SL exit deterministically after rewind", async () => {
    const ledger = new ReplayLedger(0, initialAccount(cfg));
    await ledger.seek(2,bars,cfg,USOIL_S);
    const id = buy(ledger,89.20);
    const shock: Candle = { ...bars[6], low: 89.18, close: 89.22 };
    const candles = [...bars.slice(0,6),shock,bars[7]];
    await ledger.seek(6,candles,cfg,USOIL_S);
    expect(ledger.account.history[0].exitReason).toBe("stop_loss");
    await ledger.seek(5,candles,cfg,USOIL_S);
    expect(ledger.account.positions[0].id).toBe(id);
    await ledger.seek(6,candles,cfg,USOIL_S);
    expect(ledger.account.history[0].exitReason).toBe("stop_loss");
  });

  it("serializes manual checkpoints and restores reversible trades from Save State", async () => {
    const ledger = new ReplayLedger(0, initialAccount(cfg));
    await ledger.seek(2,bars,cfg,USOIL_S);
    buy(ledger);
    await ledger.seek(5,bars,cfg,USOIL_S);
    const snapshot = ledger.exportSave();
    expect(validReplayLedger(snapshot)).toBe(true);
    expect(snapshot.actions).toHaveLength(1);
    const restored = ReplayLedger.fromSave(5,ledger.account,
      JSON.parse(JSON.stringify(snapshot)));
    await restored.seek(3,bars,cfg,USOIL_S);
    expect(restored.account.positions).toHaveLength(1);
    await restored.seek(1,bars,cfg,USOIL_S);
    expect(restored.account.positions).toHaveLength(0);
  });

  it("supports long jumps and replays each intermediate M1 bar for SL checks", async () => {
    const longBars: Candle[] = [];
    for (let i = 0; i < 5000; i += 1) {
      longBars.push({
        time: startTime + i * 60, open:89.4,high:89.41,low:89.39,
        close:i === 3000 ? 89.10 : 89.4,volume:10
      });
      if (i === 3000) longBars[i].low = 89.10;
    }
    const ledger = new ReplayLedger(0, initialAccount(cfg));
    buy(ledger,89.10);
    const messages: number[] = [];
    await ledger.seek(4900,longBars,cfg,USOIL_S,(done) => messages.push(done));
    expect(ledger.account.history[0]?.exitReason).toBe("stop_loss");
    expect(messages.at(-1)).toBe(4900);
    await ledger.seek(2999,longBars,cfg,USOIL_S);
    expect(ledger.account.positions).toHaveLength(1);
  });
});
