import { create } from "zustand";

import type { ConfirmInput } from "../../electron/types/api";

/**
 * Confirmação desenhada dentro do app, com a mesma assinatura do
 * `system.confirm` nativo: quem já chama um pode trocar pelo outro sem mexer
 * no resto. Um pedido por vez — abrir outro enquanto um está na tela responde
 * "cancelar" ao anterior, em vez de empilhar diálogos.
 */
export interface ConfirmRequest extends ConfirmInput {
  /** Pinta o botão de confirmar como destrutivo (fechar, excluir). */
  danger?: boolean;
}

interface ConfirmDialogState {
  request: ConfirmRequest | null;
  resolve: ((confirmed: boolean) => void) | null;
  open: (request: ConfirmRequest) => Promise<boolean>;
  settle: (confirmed: boolean) => void;
}

export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  request: null,
  resolve: null,
  open: (request) =>
    new Promise<boolean>((resolve) => {
      get().resolve?.(false);
      set({ request, resolve });
    }),
  settle: (confirmed) => {
    const { resolve } = get();
    set({ request: null, resolve: null });
    resolve?.(confirmed);
  },
}));

export function confirmInApp(request: ConfirmRequest): Promise<boolean> {
  return useConfirmDialogStore.getState().open(request);
}
