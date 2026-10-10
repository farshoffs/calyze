import type { InstrumentSpec, SessionSchedule } from "../types";
import { marginForOrder, quote } from "../lib/account";
import type { AccountConfig } from "../types";

interface Props {
  instrument: InstrumentSpec;
  account: AccountConfig;
  chartPrice: number;
  update: (key: keyof InstrumentSpec, value: string) => void;
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

function Sessions({ title, schedule }: { title: string; schedule?: SessionSchedule }) {
  if (!schedule) return null;
  return (
    <div className="spec-sessions">
      <h4>{title} (broker server time)</h4>
      {WEEKDAYS.map((day) => (
        <div className="spec-row" key={day}>
          <span>{day}</span>
          <strong>{schedule[day] ? schedule[day].start + "–" + schedule[day].end : "Closed"}</strong>
        </div>
      ))}
    </div>
  );
}

function SpecRow({ label, value }: { label: string; value: string | number }) {
  return <div className="spec-row"><span>{label}</span><strong>{value}</strong></div>;
}

export default function InstrumentDetails({ instrument: spec, account, chartPrice, update }: Props) {
  const isOil = spec.symbol === "USOIL.S";
  const digits = spec.digits ?? 2;
  const q = quote(chartPrice, spec);
  const buyMargin = marginForOrder("buy", 1, chartPrice, account, spec);
  const sellMargin = marginForOrder("sell", 1, chartPrice, account, spec);
  const format = (n: number) => Number.isFinite(n) ? n.toFixed(2) : "—";

  return (
    <details className="spec-card" open={isOil ? true : undefined}>
      <summary><strong>{spec.symbol}</strong> · Contract specification</summary>
      <div className="spec-list">
        <SpecRow label="Instrument" value={isOil ? "Crude Oil (WTI)" : spec.symbol} />
        <SpecRow label="Digits" value={digits} />
        <SpecRow label="Contract size" value={spec.contractSize} />
        <SpecRow label="Spread" value={spec.spreadMode === "floating" ? "Floating (modelled)" : "Fixed (modelled)"} />
        <SpecRow label="Stops level" value={(spec.stopsLevelPoints ?? 0) + " points"} />
        <SpecRow label="Margin currency" value={spec.marginCurrency || account.currency} />
        <SpecRow label="Profit currency" value={spec.profitCurrency || account.currency} />
        <SpecRow label="Calculation" value={spec.marginCalculation === "notional" ? "Notional value" : "Contract notional"} />
        <SpecRow label="Tick size" value={spec.tickSize} />
        <SpecRow label="Tick value" value={"$" + (spec.tickValue ?? spec.tickSize * spec.contractSize).toFixed(2) + " / lot"} />
        <SpecRow label="Chart mode" value={spec.chartMode === "bid" ? "By bid price" : "Mid (simulated)"} />
        <SpecRow label="Execution" value="Market execution" />
        <SpecRow label="GTC mode" value="Good till cancelled" />
        <SpecRow label="Filling" value="Fill or Kill (simulated)" />
        <SpecRow label="Minimum volume" value={spec.minLot} />
        <SpecRow label="Maximum volume" value={spec.maxLot} />
        <SpecRow label="Volume step" value={spec.lotStep} />
        <SpecRow label="Volume limit" value={spec.volumeLimit ?? "Broker dependent"} />
        <SpecRow label="Swap type" value={spec.swapCurrency || "—"} />
        <SpecRow label="Swap long" value={spec.swapLong ?? 0} />
        <SpecRow label="Swap short" value={spec.swapShort ?? 0} />
      </div>
      {isOil && (
        <>
          <h4>Margin · initial / maintenance</h4>
          <div className="spec-row"><span>Buy · $/lot</span><strong>≈ {format(buyMargin)} / {format(buyMargin)}</strong></div>
          <div className="spec-row"><span>Sell · $/lot</span><strong>≈ {format(sellMargin)} / {format(sellMargin)}</strong></div>
          <p className="spec-note">Estimated using current imported price and 1:{account.leverage} leverage, not a broker-reported margin. Screenshot values were snapshots.</p>
          <h4>Swap rates</h4>
          {WEEKDAYS.slice(0,5).map((day, i) =>
            <SpecRow key={day} label={day} value={(spec.swapMultipliers?.[i + 1] ?? 1) + "×"} />
          )}
          <Sessions title="Quote sessions" schedule={spec.quoteSessions} />
          <Sessions title="Trade sessions" schedule={spec.tradeSessions} />
        </>
      )}
      <h4>Historical simulation assumptions</h4>
      <p className="spec-note">
        The M1 CSV contains chart OHLC, not historical bid/ask spread, account leverage or broker rollover timezone.
        Adjust these values to your actual account. Trading sessions apply once an offset is provided.
      </p>
      <div className="settings-grid">
        <label>Spread in USD price units
          <input type="number" min="0" step={spec.tickSize} value={spec.spread}
            onChange={(e) => update("spread", e.target.value)} />
        </label>
        <label>Commission round-trip $/lot
          <input type="number" min="0" step="0.01" value={spec.commissionPerLotRoundTurn}
            onChange={(e) => update("commissionPerLotRoundTurn", e.target.value)} />
        </label>
        <label>Contract size
          <input type="number" min="1" step="1" value={spec.contractSize}
            onChange={(e) => update("contractSize", e.target.value)} />
        </label>
        <label>Rollover hour (UTC)
          <input type="number" min="0" max="23" step="1" value={spec.swapRolloverUtcHour ?? 0}
            onChange={(e) => update("swapRolloverUtcHour", e.target.value)} />
        </label>
        <label>Broker server UTC offset (blank = don't enforce session)
          <input type="number" min="-12" max="14" step="1" placeholder="Unknown"
            value={spec.serverUtcOffsetHours ?? ""}
            onChange={(e) => update("serverUtcOffsetHours", e.target.value)} />
        </label>
      </div>
      <div className="spec-row"><span>Current bid / modelled ask</span>
        <strong>{q.bid.toFixed(digits)} / {q.ask.toFixed(digits)}</strong>
      </div>
    </details>
  );
}
