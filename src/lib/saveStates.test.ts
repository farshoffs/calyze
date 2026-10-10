import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountConfig, AccountState, Candle } from "../types";
import { USOIL_S } from "./instruments";
import {
  createSlot, drawingStorageKey, isSnapshot, listLocalSaves,
  makeDatasetIdentity, mergedSaves, putLocalSave, removeLocalSave,
  restoreStoredDrawings, readStoredDrawings, snapshotsMatch, type SaveStateSnapshot
} from "./saveStates";

const config: AccountConfig = {
  currency: "USD", initialBalance: 100, leverage: 500,
  marginCallLevel: 100, stopOutLevel: 50
};

const ledger: AccountState = {
  balance: 136.45, lastBarTime: 1767463200,
  positions: [{
    id: "pos-1", side: "buy", lots: 0.1, openTime: 1767463140,
    openPrice: 88.42, stopLoss: 88.20, takeProfit: 89,
    commissionPaid: 0, swapAccrued: 0
  }],
  history: [{
    id: "pos-2", side: "sell", lots: 0.2, openTime: 1767400000,
    openPrice: 90.45, closeTime: 1767420000, closePrice: 90.1,
    rawPnl: 7, netPnl: 7, commissionPaid: 0, exitReason: "take_profit"
  }]
};

const candles: Candle[] = [
  {time:1767463140,open:88,high:89,low:87,close:88.4,volume:1},
  {time:1767463200,open:88.4,high:88.5,low:88.3,close:88.45,volume:2}
];

function snapshot(): SaveStateSnapshot {
  const dataset = makeDatasetIdentity(
    {name:"fxpro_WTI_m1.csv",size:338470633} as File,
    candles,"fxpro_WTI_m1","89a6f057-86d9-4661-8c90-977af5a23313"
  );
  return {
    version:1, dataset, accountName:"Account 2", replayIndex:1,
    replayTime:candles[1].time, timeframe:"M15", speed:8,
    accountConfig:config, instrument:USOIL_S, account:ledger,
    ticket:{lots:0.1,stopLoss:"88.20",takeProfit:"89.00"},
    drawings:[], savedAt:"2026-10-10T00:00:00.000Z"
  };
}

describe("Save State / Resume Backtest", () => {
  const saved = new Map<string,string>();
  beforeEach(() => {
    saved.clear();
    vi.stubGlobal("localStorage",{
      getItem:(k:string)=>saved.get(k)??null,
      setItem:(k:string,v:string)=>{saved.set(k,v);},
      removeItem:(k:string)=>{saved.delete(k);}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("captures replay position, account balance, trades, leverage, SL/TP and instrument", () => {
    const s = snapshot();
    expect(isSnapshot(s)).toBe(true);
    const serialized = JSON.stringify(s);
    expect(serialized).not.toContain("338470633,");
    const read = JSON.parse(serialized) as SaveStateSnapshot;
    expect(read.replayTime).toBe(candles[1].time);
    expect(read.account.history[0].netPnl).toBe(7);
    expect(read.account.positions[0].stopLoss).toBe(88.20);
    expect(read.accountConfig.leverage).toBe(500);
    expect(read.instrument.symbol).toBe("USOIL.S");
    expect(read.ticket.takeProfit).toBe("89.00");
  });

  it("matches original source data and rejects mismatched datasets", () => {
    const original=snapshot().dataset;
    expect(snapshotsMatch(original,{...original,key:"changed",cloudDatasetId:original.cloudDatasetId})).toBe(true);
    expect(snapshotsMatch({...original,key:"other",cloudDatasetId:null},original)).toBe(false);
    expect(isSnapshot({...snapshot(),version:2})).toBe(false);
  });

  it("keeps named accounts independently while replacing only latest autosave", () => {
    const s=snapshot();
    const slotA=createSlot(s,"Account A","manual","id-A");
    const slotB=createSlot({...s, accountName:"Account B",
      account:{...s.account,balance:54.12}},"Account B","manual","id-B");
    putLocalSave("user-1",slotA);
    putLocalSave("user-1",slotB);
    putLocalSave("user-1",createSlot(s,"Latest","auto","auto-1"));
    putLocalSave("user-1",createSlot({...s,replayIndex:0,
      replayTime:candles[0].time},"Latest","auto","auto-2"));
    const rows=listLocalSaves("user-1");
    expect(rows.filter(row=>row.kind==="auto")).toHaveLength(1);
    expect(rows.find(row=>row.id==="id-A")?.snapshot.account.balance).toBe(136.45);
    expect(rows.find(row=>row.id==="id-B")?.snapshot.account.balance).toBe(54.12);
    expect(listLocalSaves("user-2")).toHaveLength(0);
    removeLocalSave("user-1","id-A");
    expect(listLocalSaves("user-1").some(row=>row.id==="id-A")).toBe(false);
  });

  it("retains drawing snapshots (including empty) and merges newer cloud rows", () => {
    const d= { id:"shape-1",kind:"horizontal" as const,
      anchors:[{time:candles[0].time,price:89}],
      color:"#fff",width:2,dash:"solid" as const };
    restoreStoredDrawings("guest","fxpro_WTI_m1","USOIL.S",[d]);
    expect(readStoredDrawings("guest","fxpro_WTI_m1","USOIL.S")).toHaveLength(1);
    expect(drawingStorageKey("guest","fxpro_WTI_m1","USOIL.S"))
      .toBe("calyze:drawings:v2:guest:fxpro_WTI_m1:USOIL.S");
    restoreStoredDrawings("guest","fxpro_WTI_m1","USOIL.S",[]);
    expect(readStoredDrawings("guest","fxpro_WTI_m1","USOIL.S")).toEqual([]);
    const local=createSlot(snapshot(),"Version A","manual","id-a");
    const remote={...local,name:"Version B",updatedAt:"2099-01-01T00:00:00.000Z" };
    expect(mergedSaves([local],[remote])[0].name).toBe("Version B");
  });
});
