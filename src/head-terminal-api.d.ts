import type { HeadTerminalApi } from "../electron/types/api";

declare global {
  interface Window {
    headTerminal: HeadTerminalApi;
  }
}

export {};
