import { useEffect, useRef, useCallback } from "react";

interface SessionContextMenuProps {
  x: number;
  y: number;
  pinned: boolean;
  onRename: () => void;
  onTogglePin: () => void;
  onDuplicate: () => void;
  onClose: () => void;
  onDismiss: () => void;
}

export function SessionContextMenu({
  x,
  y,
  pinned,
  onRename,
  onTogglePin,
  onDuplicate,
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
        Renomear
      </button>
      <button type="button" onClick={onTogglePin}>
        {pinned ? "Desafixar" : "Fixar"}
      </button>
      <button type="button" onClick={onDuplicate}>
        Duplicar
      </button>
      <button type="button" className="session-context-menu__danger" onClick={onClose}>
        Fechar sessão
      </button>
    </div>
  );
}
