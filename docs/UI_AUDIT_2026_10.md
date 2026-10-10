# Calyze UI audit — 10 October 2026

Scope: code-level audit of the existing React/Vite charting terminal, including mobile layouts. Runtime screenshots were not available; this is not a visual regression certification.

## Priority 1: screen hierarchy

**Finding:** Always-visible Supabase sign-in, cloud dataset shelf, and Save State forms were stacked above the chart. The market chart could be pushed below the first screen, especially on a small phone.

**Resolution:** The primary workspace is chart-first. Saves and the cloud library now open on demand through header actions. Compact account stats stay visible; the entire Save State and Supabase workflows remain accessible in an independently scrollable responsive drawer.

## Priority 2: mobile workflows

**Finding:** Trading required scrolling through a chart to an order ticket and then a separate history table. The chart was sized relative to viewport but secondary content competed for the same scroll.

**Resolution:** Dedicated Chart / Trade / History views on widths <=900px without unmounting the chart. On mobile the ticket exposes a link to open positions; History contains tabs for open and closed trades.

## Priority 3: trade transparency and execution feedback

**Finding:** Price was shown as a single chart number with small modeled-ask text; little preview of entry margin; closed history was a six-item chip strip rather than a complete record.

**Resolution:** Two-column bid/ask quote, labeled BUY/SELL MARKET buttons, estimated buy/sell margin and spread cost, a persistent order-status ribbon, and full closed-history ledger with reason and realized P/L. The underlying account math is unchanged.

## Priority 4: replay safety

**Finding:** The historical timeline slider reset account and positions continuously while being dragged, with no confirmation.

**Resolution:** Slider now only previews the destination. An explicit Go action applies the seek, with confirmation when trades would be discarded. Reset account and file-switching also confirm before destroying a populated trading ledger. The date picker remains direct.

## Priority 5: information density

**Finding:** USOIL.S contract details auto-expanded to a long technical section, competing with the manual order ticket. Many labels were ~10-11px and controls were hard to tap.

**Resolution:** Contract details collapse by default. Main buttons, mobile drawing rail, timeframes and replay controls have stronger contrast and larger mobile hit regions. Form labels and navigation hierarchy are improved.

## Priority 6: accessibility and modal behavior

**Finding:** Hidden sign-in error messages, minimal focus treatment, and overlapping secondary panels impeded keyboard and screen-reader navigation.

**Resolution:** Drawer focus restoration, Escape and backdrop dismiss, Tab cycling, dialog semantics, form labels, status feedback, aria-pressed on mobile navigation, visible focus outlines, reduced-motion handling.

## Unchanged functional behavior

- M1 cTrader CSV importer and optional Supabase archive
- Candles and timeframe aggregation
- Drawing toolkit and persisted drawing anchors
- MT-style order execution, broker-specific margin and swap calculation
- Local and cloud backtest save-state format

## Validation

- GitHub Actions TypeScript typecheck
- Vitest unit tests
- Vite production PWA build

## Follow-up test matrix

After deployment, manually inspect Chrome desktop (1440px), iPad portrait (~820px), iPhone (~390px), and a compact 320px device. Verify:
1. Import WTI CSV; chart stays visible in Chart view
2. Date/time replay, slider preview/Go, margin and spread information
3. Drawer focus, cloud authentication, dataset listing and backup progress
4. Drawing creation/editing/restore from saved state
5. Open long/short, switch Trade/History, close order, inspect all closed trades
6. Autosave and named save, resume on same device and with a cloud-backed CSV on another device
7. Rotate mobile, check chart canvas resizes and buttons remain accessible

A green build confirms compilation, not pixel-perfect rendering or a completed 338 MB CSV browser import.
