import { describe, expect, it } from "vitest";
import { USOIL_S, instrumentFromImport } from "./instruments";
import {
  advanceAccount, closePosition, initialAccount, isTradeSession,
  marginForOrder, metrics, openPosition, positionRawPnl, quote, swapBetween
} from "./account";
import type { AccountConfig, Candle } from "../types";

const config: AccountConfig = {
  currency: "USD", initialBalance: 1000, leverage: 500,
  marginCallLevel: 100, stopOutLevel: 50
};

const candle = (when: string, bid = 89.38): Candle => ({
  time: Date.parse(when) / 1000,
  open: bid, high: bid + 0.04, low: bid - 0.04, close: bid, volume: 200
});

describe("USOIL.S broker specification (user-provided)", () => {
  it("selects WTI preset from cTrader filename and includes contract details", () => {
    expect(instrumentFromImport("fxpro_WTI_m1.csv").symbol).toBe("USOIL.S");
    expect(instrumentFromImport("usoil_m1.csv").symbol).toBe("USOIL.S");
    expect(USOIL_S.contractSize).toBe(100);
    expect(USOIL_S.tickSize).toBe(0.01);
    expect(USOIL_S.tickValue).toBe(1);
    expect(USOIL_S.minLot).toBe(0.1);
    expect(USOIL_S.maxLot).toBe(60);
    expect(USOIL_S.lotStep).toBe(0.1);
    expect(USOIL_S.volumeLimit).toBe(100);
    expect(USOIL_S.stopsLevelPoints).toBe(15);
    expect(USOIL_S.swapShort).toBe(-16);
    expect(USOIL_S.swapMultipliers?.[3]).toBe(3);
  });

  it("uses bid candles and rounds to two-digit tick grid", () => {
    expect(quote(89.384, USOIL_S).bid).toBeCloseTo(89.38);
    expect(quote(89.384, USOIL_S).ask).toBeCloseTo(89.41);
    const result = openPosition(initialAccount(config), "buy", 0.1, 89.384, 1, config, USOIL_S);
    expect(result.error).toBeUndefined();
    expect(result.state.positions[0].openPrice).toBeCloseTo(89.41);
    expect(positionRawPnl(result.state.positions[0], 89.48, USOIL_S)).toBeCloseTo(0.70);
  });

  it("calculates notional margin using account leverage; not screenshot snapshot", () => {
    expect(marginForOrder("buy", 1, 89.38, config, USOIL_S)).toBeCloseTo(17.882);
    expect(marginForOrder("sell", 1, 89.38, config, USOIL_S)).toBeCloseTo(17.876);
    const opened = openPosition(initialAccount(config), "buy", 0.1, 89.38, 1, config, USOIL_S).state;
    expect(metrics(opened, 89.38, config, USOIL_S).usedMargin).toBeCloseTo(1.7882);
  });

  it("rejects invalid lot size, steps and total volume without silently clamping", () => {
    const state = initialAccount(config);
    for (const lots of [0.01, 0.11, 60.1, -1, NaN]) {
      expect(openPosition(state, "buy", lots, 89, 1, config, USOIL_S).error).toBeTruthy();
    }
    const highBalance = { ...config, initialBalance: 100000 };
    let next = initialAccount(highBalance);
    next = openPosition(next, "buy", 60, 89, 1, highBalance, USOIL_S).state;
    next = openPosition(next, "buy", 40, 89, 1, highBalance, USOIL_S).state;
    expect(next.positions).toHaveLength(2);
    expect(openPosition(next, "buy", 0.1, 89, 1, highBalance, USOIL_S).error).toMatch(/volume/i);
  });

  it("requires a 0.15 price gap for SL/TP and checks correct bid/ask", () => {
    const state = initialAccount(config);
    expect(openPosition(state, "buy", 0.1, 89.38, 1, config, USOIL_S, 89.30).error).toMatch(/SL/);
    expect(openPosition(state, "buy", 0.1, 89.38, 1, config, USOIL_S, undefined, 89.45).error).toMatch(/TP/);
    expect(openPosition(state, "sell", 0.1, 89.38, 1, config, USOIL_S, 89.47).error).toMatch(/SL/);
    expect(openPosition(state, "sell", 0.1, 89.38, 1, config, USOIL_S, undefined, 89.33).error).toMatch(/TP/);
    expect(openPosition(state, "buy", 0.1, 89.38, 1, config, USOIL_S, 89.20, 89.56).error).toBeUndefined();
  });

  it("uses modeled ASK high for sell-stop execution", () => {
    const state = openPosition(initialAccount(config), "sell", 0.1, 89.38, 1,
      config, USOIL_S, 89.55).state;
    const after = advanceAccount(state, {
      time: 120, open: 89.38, high: 89.53, low: 89.35, close: 89.4, volume: 1
    }, config, USOIL_S);
    expect(after.history[0]?.exitReason).toBe("stop_loss");
  });

  it("applies Wednesday triple short rollover while long swap stays zero", () => {
    const monday = Date.parse("2026-10-05T12:00:00Z") / 1000;
    const thu = Date.parse("2026-10-08T01:00:00Z") / 1000;
    const short = openPosition(initialAccount(config), "sell", 1, 89.38, monday,
      config, USOIL_S).state.positions[0];
    expect(swapBetween(short, monday, thu, USOIL_S)).toBe(-16 * (1 + 3 + 1));
    expect(swapBetween({ ...short, side: "buy" }, monday, thu, USOIL_S)).toBe(0);
    // Existing position gets charged at rollover; balance is realized on close.
    const near = advanceAccount({ ...initialAccount(config), positions: [short] },
      candle("2026-10-06T00:01:00Z"), config, USOIL_S);
    expect(near.positions[0].swapAccrued).toBe(-16);
    const afterClose = closePosition(near, short.id, 89.38,
      Date.parse("2026-10-06T00:02:00Z") / 1000, USOIL_S);
    expect(afterClose.history[0].netPnl).toBeLessThan(-16);
  });

  it("does not pretend trading session timezone is known from screenshots", () => {
    expect(isTradeSession(Date.parse("2026-10-10T12:00:00Z") / 1000, USOIL_S)).toBe(true);
    const withOffset = { ...USOIL_S, serverUtcOffsetHours: 0 };
    expect(isTradeSession(Date.parse("2026-10-10T12:00:00Z") / 1000, withOffset)).toBe(false);
    expect(isTradeSession(Date.parse("2026-10-05T00:55:00Z") / 1000, withOffset)).toBe(false);
    expect(isTradeSession(Date.parse("2026-10-05T01:10:00Z") / 1000, withOffset)).toBe(true);
  });
});
