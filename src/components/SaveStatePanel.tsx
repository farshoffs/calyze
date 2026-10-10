import type { SaveSlot } from "../lib/saveStates";

interface Props {
  accountName: string;
  onAccountNameChange: (name: string) => void;
  saveName: string;
  onSaveNameChange: (name: string) => void;
  slots: SaveSlot[];
  hasDataset: boolean;
  cloudReady: boolean;
  busy: boolean;
  status: string;
  onSave: () => void;
  onNewAccount: () => void;
  onResume: (slot: SaveSlot) => void;
  onOverwrite: (slot: SaveSlot) => void;
  onDelete: (slot: SaveSlot) => void;
  onRefresh: () => void;
}

function displayTime(time: number): string {
  return new Date(time * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export default function SaveStatePanel({
  accountName, onAccountNameChange, saveName, onSaveNameChange,
  slots, hasDataset, cloudReady, busy, status,
  onSave, onNewAccount, onResume, onOverwrite, onDelete, onRefresh
}: Props) {
  return (
    <section className="save-state-panel" aria-label="Backtest save states">
      <header className="save-header">
        <div><strong>Save State / Resume</strong>
          <span>Checkpoint your historical trading session</span>
        </div>
        <button onClick={onRefresh} disabled={busy}>Refresh</button>
      </header>
      <div className="save-input-row">
        <label>Account profile
          <input aria-label="Account name" value={accountName}
            maxLength={80} onChange={(e) => onAccountNameChange(e.target.value)} />
        </label>
        <label>Named save
          <input aria-label="Save name" value={saveName}
            placeholder="e.g. WTI March NY setup" maxLength={100}
            onChange={(e) => onSaveNameChange(e.target.value)} />
        </label>
        <button className="save-primary" disabled={!hasDataset || busy || !saveName.trim()} onClick={onSave}>
          Save now
        </button>
        <button disabled={!hasDataset || busy} onClick={onNewAccount}>New account</button>
      </div>
      <p className="save-description">
        Automatic checkpoint every 20 seconds while the dataset is open.
        {cloudReady
          ? " Synced to Supabase approximately every minute once the imported CSV is backed up."
          : " Local device saves work without sign-in. Sign in and back up the CSV for cross-device resume."}
      </p>
      {status && <p className="save-status" role="status">{status}</p>}
      <div className="save-slot-list">
        {slots.length === 0 && <p className="save-empty">No saved sessions yet. Open a dataset to enable autosave, or create a named save.</p>}
        {slots.map((slot) => (
          <div className="save-slot" key={slot.id}>
            <div className="save-slot-details">
              <strong>{slot.kind === "auto" ? "◷ " : "▣ "}{slot.name}</strong>
              <span>{slot.snapshot.accountName} · {slot.snapshot.dataset.name} · {slot.snapshot.instrument.symbol}</span>
              <span>{displayTime(slot.snapshot.replayTime)} · {slot.snapshot.timeframe} ·
                Balance {slot.snapshot.accountConfig.currency} {slot.snapshot.account.balance.toFixed(2)} ·
                {slot.snapshot.account.positions.length} open / {slot.snapshot.account.history.length} closed</span>
              <small>Saved {new Date(slot.updatedAt).toLocaleString()} · {slot.source === "cloud" ? "Supabase" : "Device"}</small>
            </div>
            <div className="save-slot-actions">
              <button disabled={busy} onClick={() => onResume(slot)}>Resume</button>
              {slot.kind === "manual" && (
                <button disabled={!hasDataset || busy} onClick={() => onOverwrite(slot)}>Overwrite</button>
              )}
              <button disabled={busy} className="save-delete" onClick={() => onDelete(slot)}>Delete</button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
