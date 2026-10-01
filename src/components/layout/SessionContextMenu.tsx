import { useEffect, useRef, useCallback } from "react";

import { msg } from "../../i18n";

interface SessionContextMenuProps {
  x: number;
  y: number;
  pinned: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onChangeFolder: () => void;
  /** Ausente quando a sessão já está numa árvore isolada ou fora de um repo. */
  onIsolate?: () => void;
  onDuplicate: () => void;
  /** Ausente quando a sessão não está rodando. */
  onHibernate?: () => void;
  onClose: () => void;
  onDismiss: () => void;
}

export function SessionContextMenu({
  x,
  y,
  pinned,
  onRename,
  onTogglePin,
  onChangeFolder,
  onIsolate,
  onDuplicate,
  onHibernate,
  onClose,
  onDismiss,
}: SessionContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  const dismiss = useCallback(() => onDismiss(), [onDismiss]);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        dismiss();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [dismiss]);

  return (
    <div
      ref={ref}
      className="session-context-menu"
      style={{ left: x, top: y }}
      role="menu"
    >
      <button type="button" onClick={onRename}>
        {msg.app.sessionMenu.rename}
      </button>
      <button type="button" onClick={onTogglePin}>
        {pinned ? msg.app.sessionMenu.unpin : msg.app.sessionMenu.pin}
      </button>
      <button type="button" onClick={onChangeFolder}>
        {msg.app.sessionMenu.changeFolder}
      </button>
      {onIsolate && (
        <button type="button" onClick={onIsolate}>
          {msg.app.sessionMenu.isolate}
        </button>
      )}
      <button type="button" onClick={onDuplicate}>
        {msg.app.sessionMenu.duplicate}
      </button>
      {onHibernate && (
        <button type="button" onClick={onHibernate}>
          {msg.app.sessionMenu.hibernate}
        </button>
      )}
      <button type="button" className="session-context-menu__danger" onClick={onClose}>
        {msg.app.sessionMenu.close}
      </button>
    </div>
  );
}
