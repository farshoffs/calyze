# Calyze architecture

## Product goal

Calyze is a historical charting and discretionary backtesting terminal. It deliberately has no live-price provider and no broker connection. The source of truth is M1 OHLCV exported from cTrader.

## One codebase, four targets

The frontend is React + Vite. Capacitor wraps the same production build for Android and iOS, while vite-plugin-pwa makes the web build installable as a PWA.

This keeps the replay and account engines identical on every target.

## Market-data pipeline

1. User selects a cTrader CSV.
2. Papa Parse reads the file in a worker.
3. Header aliases are normalized for common cTrader formats.
4. Timestamps are converted to UTC epoch seconds.
5. Duplicate M1 timestamps are removed.
6. Higher timeframes are generated from M1 in memory.

The first implementation supports M1, M5, M15, M30, H1, H4 and D1.

## Charting

The chart uses TradingView Lightweight Charts. Calyze owns the interaction layer. The MVP includes:
- Candlesticks
- Crosshair
- Horizontal price lines
- Two-point trend lines
- SMA 20 and SMA 50
- Replay-follow behavior

The drawing layer is intentionally app-owned so more TradingView-like tools can be added without changing the data engine.

## Replay model

M1 is the replay clock even when the chart displays a higher timeframe. Each replay step advances exactly one imported M1 bar. The visible higher-timeframe series is cut off at the current M1 timestamp.

This prevents future candles from leaking into a higher-timeframe chart.

## MT4-style account simulator

The simulator is deterministic and separate from rendering.

For a generic USD-quoted CFD:

notional = open_price × contract_size × lots

required_margin = notional / leverage

equity = balance + floating_PnL

free_margin = equity - used_margin

margin_level_percent = equity / used_margin × 100

A buy opens at ask and closes at bid. A sell opens at bid and closes at ask. The configured spread is applied around the imported candle price.

Commission is charged half on entry and half on exit.

For SL/TP ambiguity inside one M1 candle, the MVP deliberately uses a conservative rule: if both SL and TP are touched in the same M1 bar, SL is assumed to occur first.

Stop-out is evaluated after each replayed M1 candle. If margin level is at or below the configured stop-out threshold, all remaining positions are liquidated at the current simulated quote.

## Instrument presets

Instrument behavior is explicit instead of hard-coded:
- symbol
- contract size
- tick size
- spread in price units
- round-turn commission per lot
- min/max lot
- lot step

This is important for XAUUSD, USOIL and FX instruments because contract and margin conventions differ by broker.

## Supabase

The app is local-first. Imported data is immediately usable before upload.

When Supabase is configured, users can authenticate and save:
- dataset metadata
- normalized M1 candles
- workspaces/drawings
- backtest accounts
- trades

M1 candles are uploaded in chunks to avoid oversized browser requests.

All exposed tables have Row Level Security. The frontend is designed to use only a publishable key. A service-role/secret key must never be bundled into the web, Android, or iOS app.

## Next implementation slices

1. Persist/reload full workspaces and trade histories.
2. More drawing tools: ray, rectangle/zone, Fibonacci, risk/reward, text and measurement.
3. Indicators: EMA, RSI, MACD, ATR, Bollinger Bands, VWAP and custom indicator registry.
4. Pending orders and limit/stop execution.
5. Broker-specific symbol presets for FxPro cTrader.
6. Trade journal, screenshots and tags.
7. Strategy batch backtester on the same execution engine.
8. Exportable performance report: WR, PF, expectancy, max DD, streaks, monthly results and R-multiples.
