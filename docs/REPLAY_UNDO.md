# Calyze: reversible M1 replay (Trade Undo)

Replaying earlier candles is a time-travel operation, NOT an account reset.

## Timeline semantics

- Rewind to **after a manually entered trade**: the open position remains with its original entry price, lot size, stop loss, take profit, commission and swaps accumulated through the chosen candle. Floating P/L is recalculated from that candle's historical bid/ask model.
- Rewind **before a trade entry**: entry and any later account events are undone. Advancing again does NOT automatically recreate an undone manual order. This is a new trading branch: reenter manually if desired.
- Rewind before a **manual close** or an automatic **SL/TP/stop-out**: the closed position reopens at its earlier state, with previous balance and accrued swaps restored as appropriate. Advancing again recalculates triggers using each M1 candle, stop first if both SL and TP are hit in one candle.
- Forward jump: every intervening M1 candle is processed in order while positions are open, ensuring stops, margin stopout and rollover are not bypassed. When no positions are open, the ledger can skip ahead.
- Timeline slider previews a destination; **Go**, the previous candle button, the date picker and jump-to-start all use the same reversible ledger. During a long seek, execution buttons are disabled and progress is shown.

## Save State

Manual entry and manual close checkpoints are included in the existing version 1 save-state JSON as the optional `replayLedger` field. It preserves the reversible action history without embedding the full M1 data file or storing millions of periodic snapshots.

Old saves (created before this update) still restore their account, positions and history, but their previous manual actions cannot be reconstructed. Therefore an old save is the initial anchor for rewinds.

Named saves and automatic cloud checkpoints use the same logic. A deliberate **Reset account** or **New account** still starts a fresh trading ledger.

## Broker fidelity

All manual market entries retain the configured USOIL.S bid/ask spread, contract size, leverage, 0.1-lot minimum and the original execution timestamp. The model is M1 OHLC-only and therefore cannot reconstruct historical variable spread or precise intraminute execution order.

## Regression tests

- Unit tests: profitable rewinds, entry undo, manual close rollback, automatic SL resimulation, long time jumps and reversible saved sessions
- Chromium tests: import WTI, BUY after the initial replay candles, advance into profit, rewind a few candles while retaining entry, and rewind across entry to undo
