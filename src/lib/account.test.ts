import { describe, expect, it } from "vitest";
import {
  advanceAccount,
  initialAccount,
  metrics,
  openPosition,
  positionRawPnl
} from "./account";
import type { AccountConfig, InstrumentSpec } from "../types";

const config: AccountConfig = {
  currency: "USD",
  initialBalance: 1000,
  leverage: 100,
  marginCallLevel: 100,
  stopOutLevel: 50
};

const spec: InstrumentSpec = {
  symbol: "XAUUSD",
  contractSize: 100,
  tickSize: 0.01,
  spread: 0.2,
  commissionPerLotRoundTurn: 0,
  minLot: 0.01,
  maxLot: 100,
  lotStep: 0.01
};

describe("leveraged account engine", () => {
  it("calculates CFD margin and floating P/L", () => {
    const opened = openPosition(initialAccount(config), "buy", 0.1, 2000, 1, config, spec);
    expect(opened.error).toBeUndefined();
    expect(opened.state.positions).toHaveLength(1);

    const position = opened.state.positions[0];
    expect(position.openPrice).toBeCloseTo(2000.1, 6);
    expect(positionRawPnl(position, 2001, spec)).toBeCloseTo(8, 6);

    const marked = metrics(opened.state, 2001, config, spec);
    expect(marked.usedMargin).toBeCloseTo(200.01, 4);
    expect(marked.equity).toBeCloseTo(1008, 4);
    expect(marked.marginLevel).toBeCloseTo((1008 / 200.01) * 100, 4);
  });

  it("uses the stop loss first when SL and TP both occur in one M1 bar", () => {
    const opened = openPosition(
      initialAccount(config),
      "buy",
      0.1,
      2000,
      1,
      config,
      spec,
      1999,
      2001
    );

    const after = advanceAccount(
      opened.state,
      { time: 2, open: 2000, high: 2002, low: 1998, close: 2000.5, volume: 1 },
      config,
      spec
    );

    expect(after.positions).toHaveLength(0);
    expect(after.history[0].exitReason).toBe("stop_loss");
    expect(after.history[0].closePrice).toBe(1999);
  });
});
