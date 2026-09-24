import { useEffect, useRef } from "react";

import { useConfirmDialogStore } from "../../core/confirm-dialog";

/**
 * Renderiza o pedido de confirmação pendente (ver core/confirm-dialog.ts).
 * Montado uma vez, no App; Enter confirma, Esc e clique fora cancelam.
 */
export function ConfirmDialog() {
  const request = useConfirmDialogStore((state) => state.request);
  const settle = useConfirmDialogStore((state) => state.settle);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    confirmRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        settle(false);
      } else if (event.key === "Enter") {
        event.stopImmediatePropagation();
        settle(true);
      }
    };
    // Captura: os atalhos globais do app e o xterm não podem ver estas teclas.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [request, settle]);

  if (!request) return null;

  return (
    <div className="confirm-dialog-backdrop" onClick={() => settle(false)}>
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-dialog-title" className="confirm-dialog__title">
          {request.title ?? request.message}
        </h2>
        {request.title && (
          <p className="confirm-dialog__message">{request.message}</p>
        )}
        {request.detail && (
          <p className="confirm-dialog__detail">{request.detail}</p>
        )}
        <div className="confirm-dialog__actions">
          <button type="button" onClick={() => settle(false)}>
            {request.cancelLabel ?? "Cancelar"}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={
              request.danger
                ? "confirm-dialog__confirm confirm-dialog__confirm--danger"
                : "confirm-dialog__confirm"
            }
            onClick={() => settle(true)}
          >
            {request.confirmLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
