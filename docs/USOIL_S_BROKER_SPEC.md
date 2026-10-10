# USOIL.S historical backtesting profile

The USOIL.S preset is derived from user-provided MetaTrader broker contract specification screenshots, and is automatically selected for filenames containing WTI or USOIL (e.g. `fxpro_WTI_m1.csv`).

## Broker contract properties

| Property | Screenshot |
|---|---|
| Symbol | USOIL.S |
| Description | USOIL Crude Oil (WTI) |
| Digits | 2 |
| Contract size | 100 |
| Tick size | 0.01 |
| Tick value | USD 1 per full lot |
| Chart mode | Bid |
| Min volume | 0.1 |
| Max volume | 60 |
| Volume step | 0.1 |
| Aggregate open volume limit | 100 |
| Stops level | 15 points = USD 0.15 |
| Margin/profit currency | USD |
| Margin calculation | Notional value |
| Swap type | USD |
| Swap long | 0 |
| Swap short | −16 per lot |
| Wednesday swap factor | 3 |
| Spread | Floating |

Quote sessions (broker server local times): Monday–Friday 01:00–23:59.

Trading sessions (broker server local times): Monday 01:05–23:58, Tuesday–Thursday 01:02–23:58, Friday 01:02–23:55. Saturday and Sunday closed.

## Calculations

At chart bid price `B`, configured modeling spread `S`, 100 units per lot and 1:`L` account leverage:

- Bid = rounded B to nearest USD 0.01
- Ask = rounded (Bid + S) to nearest USD 0.01
- BUY market fill = Ask; SELL market fill = Bid
- Margin BUY per lot = Ask × 100 / L
- Margin SELL per lot = Bid × 100 / L
- P/L BUY = (exit bid − entry ask) × 100 × lots
- P/L SELL = (entry bid − exit ask) × 100 × lots
- 1 price tick USD 0.01 = USD 1 per lot = USD 0.10 per 0.1 lot

The screenshot had approximate *contemporaneous* buy/sell margins of USD 18.54/18.53 per lot. These depend on the then-prevailing quote and leverage. The app does not hard-code these values.

M1 OHLC is chart-price history, not a bid/ask tick tape. In particular, the FxPro cTrader `WTI` CSV includes prices with finer precision than the screenshot's 2-digit `USOIL.S` contract. We preserve imported OHLC for analysis but round execution quotes to the symbol tick grid. This is an approximate simulation, not proof that both feeds have identical pricing.

## Broker assumptions that require calibration

The screenshots do *not* expose:

- Realized historical floating spreads (the app assumes 0.03 USD until changed)
- Account leverage (the trading panel allows configuring it)
- Commissions (assumed zero until configured)
- Broker server time zone / UTC offset (leave blank to keep sessions informational, set offset to enforce trade hours)
- Exact swap rollover hour (simulator defaults to UTC midnight and allows changing hour)

Short swap is charged as −USD 16 × lots × weekday factor per rollover. Wednesday has a factor of 3. Long swap is zero. For swap accuracy, configure actual broker rollover UTC hour. Swap charges are included in floating equity during an open trade and realized into balance when the position closes.

## Trading engine limitations

- No intraminute spread measurements, tick slippage, or historical broker-side margin tiers.
- No volume-based liquidity simulation.
- No true server timezone can be inferred from screenshots; session rules are enforced only once an explicit broker UTC offset is supplied.
- M1 SL/TP intrabar ambiguity resolves conservatively (stop first).
- Changing instrument economics with open trades is intentionally blocked in the UI.
