import { useEffect, useRef, type ReactNode, type KeyboardEvent } from "react";

interface Props {
  title: string;
  subtitle: string;
  onClose: () => void;
  children: ReactNode;
}

export default function WorkspaceDrawer({ title, subtitle, onClose, children }: Props) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);

  function onKeyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panelRef.current) return;

    const controls = [...panelRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex="0"]'
    )].filter((control) => control.getClientRects().length > 0);
    if (!controls.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="workspace-scrim" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside ref={panelRef} className="workspace-drawer" role="dialog"
        aria-modal="true" aria-label={title} onKeyDown={onKeyboard}>
        <header className="workspace-drawer-head">
          <div>
            <span className="eyebrow">CALYZE WORKSPACE</span>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button ref={closeRef} aria-label={"Close " + title}
            className="workspace-close" onClick={onClose}>✕</button>
        </header>
        <div className="workspace-drawer-content">{children}</div>
      </aside>
    </div>
  );
}
