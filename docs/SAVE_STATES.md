# Save State / Resume Backtest

Calyze supports locally stored session checkpoints, user-named save slots, and cross-device Supabase backup when the source M1 CSV has been uploaded.

## Saving a session

Import or open a cTrader M1 file. Under **Save State / Resume**, enter an account profile name and a named save label, then select **Save now**. Named saves are independent snapshots of the trading ledger. **Overwrite** updates one selected named save without replacing the others.

The app creates a new **Latest automatic checkpoint** on this device every 20 seconds while a dataset is loaded. If signed in to Supabase *and* the CSV has finished archiving to Supabase, one checkpoint is also synchronized every ~60 seconds. A best-effort local snapshot runs when the page closes. Browser storage quota restrictions can still prevent a local save; Calyze displays a status warning.

The **New account** action resets the trading ledger and gives the profile a distinct name while retaining the current historical replay date and chart. Create a named save of the previous account before switching. Accounts are not live broker accounts.

## Snapshot fields

- Source identity: file name, size, first/last timestamp, M1 candle count, optional cloud dataset ID
- Replay date/time, M1 index, chart timeframe, replay speed
- Account profile name, balance, current open orders, SL/TP, closed history, swaps, last execution bar
- Initial account balance, leverage, margin call and stop-out configuration
- Broker instrument contract and modeling settings: spread, commission, tick, swaps, trade sessions
- Current order ticket: lots, stop loss, take profit
- Saved chart drawings (small serialized drawing anchors, not rendered image)
- Timestamp and version of checkpoint

**Raw M1 candles are not included in a save**. Re-import the original CSV or archive it to Supabase once to access a save across devices.

## Restoring

1. Select **Resume** on the corresponding named save or automatic checkpoint.
2. If the matching M1 dataset is already open, the account and chart are restored immediately.
3. Otherwise, for a save associated with a Supabase archive, Calyze downloads and parses the source dataset first.
4. If no archive is available, import the original CSV and try Resume again.
5. The app compares the source identity and exact M1 candle timestamp before restoring. Invalid data is rejected.
6. Trading replay stays **paused** after restoration, preventing accidental execution.
7. Chart drawings are restored and the chart component remounted.

## Data safety

- Supabase table: `public.backtest_save_states` with per-user row-level security and owner-scoped dataset references.
- Local saved profiles are stored in browser localStorage per user ID; clearing browser website data may delete these local checkpoints.
- Cloud sync requires sign-in, a completed source CSV backup, and available network.
- If automatic or manual cloud save fails, the app reports the error and keeps the local copy.
- The cloud data is not a live market or broker account. P&L relies on the same configured historical broker assumptions used during replay.

## Test coverage

`src/lib/saveStates.test.ts` covers account ledger serialization, replay continuity, distinct manual slots, automatic slot replacement, user-local separation, drawing restoration, and dataset mismatch detection.
