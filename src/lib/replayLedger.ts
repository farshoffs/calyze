import { advanceAccount, initialAccount } from "./account";
import type { AccountConfig, AccountState, Candle, InstrumentSpec } from "../types";

/** Manual ledger events are stored as compact account checkpoints, not entire M1 history. */
export interface ReplayLedgerData {
  version: 1;
  origin: { index: number; account: AccountState };
  actions: { index: number; account: AccountState }[];
}

interface Checkpoint {
  index: number;
  account: AccountState;
  permanent: boolean;
}

export function validReplayLedger(value: unknown): value is ReplayLedgerData {
  if (!value || typeof value !== "object") return false;
  const ledger = value as Partial<ReplayLedgerData>;
  if (ledger.version !== 1 || !ledger.origin || !Array.isArray(ledger.actions) || ledger.actions.length > 10000) {
    return false;
  }
  const check = (point: { index: number; account: AccountState }) =>
    Number.isSafeInteger(point.index) && point.index >= 0 &&
    point.account && Number.isFinite(point.account.balance) &&
    Array.isArray(point.account.positions) && Array.isArray(point.account.history);
  return check(ledger.origin) &&
    ledger.actions.every((point) => check(point)) &&
    ledger.actions.every((point, i) => point.index >= ledger.origin!.index &&
      (i === 0 || point.index >= ledger.actions[i - 1].index));
}

/**
 * A deterministic, destructive-branch replay: rewinding removes future trades,
 * while positions created at or before the target keep their original fills.
 * Automatic SL/TP, swaps and stop-outs are recalculated from revealed M1 candles.
 */
export class ReplayLedger {
  index: number;
  account: AccountState;
  private checkpoints: Checkpoint[];
  private readonly interval = 120;

  constructor(index: number, account: AccountState) {
    this.index = index;
    this.account = account;
    this.checkpoints = [{ index, account, permanent: true }];
  }

  static fromSave(
    index: number,
    account: AccountState,
    saved: ReplayLedgerData | undefined
  ): ReplayLedger {
    if (!validReplayLedger(saved) ||
        saved.origin.index > index ||
        saved.actions.some((action) => action.index > index)) {
      return new ReplayLedger(index, account);
    }
    const timeline = new ReplayLedger(saved.origin.index, saved.origin.account);
    for (const action of saved.actions) {
      if (action.index === timeline.checkpoints[0].index) {
        // An order can be created on the origin candle.
        timeline.checkpoints.push({ ...action, permanent: true });
      } else {
        timeline.checkpoints.push({ ...action, permanent: true });
      }
    }
    timeline.index = index;
    timeline.account = account;
    return timeline;
  }

  exportSave(): ReplayLedgerData {
    const permanent = this.checkpoints.filter((entry) => entry.permanent);
    return {
      version: 1,
      origin: { index: permanent[0].index, account: permanent[0].account },
      actions: permanent.slice(1).map(({ index, account }) => ({ index, account }))
    };
  }

  /** Call after a successful BUY, SELL or manual close. */
  recordAction(account: AccountState): void {
    this.account = account;
    // Same-bar manual changes coalesce; all actions on that candle stay in ledger.
    const last = this.checkpoints[this.checkpoints.length - 1];
    if (last?.index === this.index && last.permanent &&
        this.checkpoints.length > 1) {
      last.account = account;
    } else {
      this.checkpoints.push({ index: this.index, account, permanent: true });
    }
  }

  /** Rebase following explicit account reset or execution-assumption changes. */
  reset(index: number, account: AccountState): void {
    this.index = index;
    this.account = account;
    this.checkpoints = [{ index, account, permanent: true }];
  }

  /** Single M1 step while playing: never reset the broker account. */
  advanceOne(candles: Candle[], config: AccountConfig, instrument: InstrumentSpec): void {
    if (this.index >= candles.length - 1) return;
    const next = this.index + 1;
    this.account = advanceAccount(this.account, candles[next], config, instrument);
    this.index = next;
    this.addCacheIfNeeded(next);
  }

  private addCacheIfNeeded(index: number): void {
    // Avoid storing millions of empty-state snapshots, and keep saves compact.
    if (this.account.positions.length && index % this.interval === 0) {
      this.checkpoints.push({ index, account: this.account, permanent: false });
    }
  }

  /**
   * Seek across historical candles. Does not commit until processing has
   * completed. Yield for large jumps to keep mobile browsers responsive.
   * Future checkpoints are discarded on rewinds, so trades aren't re-entered
   * when play moves forward along the new branch.
   */
  async seek(
    target: number, candles: Candle[], config: AccountConfig, instrument: InstrumentSpec,
    onProgress?: (processed: number, total: number) => void
  ): Promise<{ index: number; account: AccountState; undone: boolean }> {
    if (!candles.length) throw new Error("No historical M1 candles loaded.");
    const bounded = Math.max(0, Math.min(candles.length - 1, Math.floor(target)));
    if (bounded === this.index) return { index: this.index, account: this.account, undone: false };

    const before = this.index;
    let start = before;
    let account = this.account;
    let entries = this.checkpoints;

    if (bounded < before) {
      // For dates before the very first checkpoint, there can be no surviving
      // orders. Start a fresh timeline at the earlier candle.
      if (bounded < this.checkpoints[0].index) {
        account = initialAccount(config);
        start = bounded;
        entries = [{ index: bounded, account, permanent: true }];
      } else {
        const prior = this.checkpoints.filter((point) => point.index <= bounded);
        const anchor = prior[prior.length - 1];
        account = anchor.account;
        start = anchor.index;
        entries = prior;
      }
    }

    // Rebuild on a temporary ledger; never overwrite a saved state with a
    // half-processed account during a lengthy history jump.
    const checkpoints = [...entries];
    const steps = bounded - start;
    let lastStored = checkpoints[checkpoints.length - 1]?.index ?? start;
    for (let i = start + 1; i <= bounded; i += 1) {
      if (account.positions.length === 0 && !account.lastBarTime) {
        account = { ...account, lastBarTime: candles[i].time };
      } else {
        account = advanceAccount(account, candles[i], config, instrument);
      }
      if (account.positions.length && i - lastStored >= this.interval) {
        checkpoints.push({ index: i, account, permanent: false });
        lastStored = i;
      }
      if ((i - start) % 2500 === 0) {
        onProgress?.(i - start, steps);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    // If the seek crossed a manually entered order, that order is truly undone.
    const undone = bounded < before && this.checkpoints.some(
      (point) => point.permanent && point.index > bounded
    );
    this.checkpoints = checkpoints;
    this.index = bounded;
    this.account = account;
    onProgress?.(steps, steps);
    return { index: bounded, account, undone };
  }
}
