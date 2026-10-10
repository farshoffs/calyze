# Calyze

Calyze is an offline-first trading analysis and replay terminal for cTrader-exported historical M1 data.

## Targets

One Ionic React + Capacitor codebase targets:
- Web
- Installable PWA
- Android
- iOS

## Core workflow

1. Import an M1 CSV exported from FxPro cTrader.
2. Calyze normalizes OHLCV data and builds higher timeframes locally.
3. Use chart tools and candle replay without live-market data.
4. Trade the replay with a simulated MT4-style leveraged account.
5. Review balance, equity, margin, free margin, margin level, P/L, orders, and trade history.
6. Persist datasets, workspaces, replay sessions, accounts, and trades to Supabase when configured.

## Simulator model

The engine supports configurable:
- Initial balance
- Leverage
- Contract size
- Lot step / min / max
- Spread
- Commission
- Tick size / tick value
- Margin call and stop-out levels
- Stop loss and take profit

Calyze is a historical simulator and research tool. It does not connect to a broker or place live orders.

## Development

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env` once the Supabase project is provisioned.

## Native builds

```bash
npm run build
npx cap sync
npx cap open android
npx cap open ios
```

See `docs/ARCHITECTURE.md` and `supabase/migrations/0001_initial.sql`.
