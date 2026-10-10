# cTrader import notes

Calyze expects candle data at M1 resolution and accepts common CSV header variations.

Required price columns:
- Open
- High
- Low
- Close

Time may be provided as:
- Timestamp / DateTime / Open Time
- Date + Time
- Time containing a full date-time value

Optional:
- Tick Volume / Volume

Accepted examples include ISO timestamps, Unix seconds/milliseconds, and day-first values such as 10.10.2026 14:35:00.

The importer sorts rows and removes duplicate timestamps.

For accurate simulation, export the smallest available M1 history and configure the Calyze instrument settings to match the FxPro symbol specification used during the historical period, especially contract size, spread assumption and commission.
