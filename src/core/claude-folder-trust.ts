import { decodePtyData } from "./pty-text";

/** Claude Code paints this before the REPL. The option is already selected;
 * Enter confirms it. Trust is not persisted in `$HOME` or some non-git
 * folders, so Head Terminal confirms it once per spawn — the pane cwd is a
 * folder the user already picked. Phrases are compared with every whitespace
 * removed: ConPTY paints the gaps between words as cursor moves, not spaces,
 * so a stripped Windows frame reads `Yes,Itrustthisfolder`. */
const TRUST_PHRASES = [
  "yes,itrustthisfolder",
  "doyoutrustthefilesinthisfolder",
];

const TRUST_EXIT_PHRASE = "no,exit";

const ANSI_PATTERN =
  /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|][^\x07\x1b]*(?:\x07|\x1b\\)|[()][AB012])/g;

const TAIL_CHARS = 800;
const CONFIRM_DELAY_MS = 80;
const CONFIRM_KEY = "\r";

export function stripAnsiForTrustPrompt(text: string): string {
  return text.includes("\x1b") ? text.replace(ANSI_PATTERN, "") : text;
}

export function isClaudeFolderTrustPrompt(text: string): boolean {
  const normalized = stripAnsiForTrustPrompt(text).toLowerCase().replace(/\s+/gu, "");
  if (!normalized.includes(TRUST_EXIT_PHRASE)) {
    return false;
  }
  return TRUST_PHRASES.some((phrase) => normalized.includes(phrase));
}

/**
 * Watches a Claude Code pane and sends Enter once when the workspace trust
 * dialog is on screen. One shot per spawn: later "1." approval prompts are
 * left for the user.
 */
export class ClaudeFolderTrustAutoAccept {
  private buffer = "";
  private confirmed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  onData(data: string | Uint8Array, confirm: () => void): void {
    if (this.confirmed) {
      return;
    }

    this.buffer = (
      this.buffer + stripAnsiForTrustPrompt(decodePtyData(data))
    ).slice(-TAIL_CHARS);

    if (!isClaudeFolderTrustPrompt(this.buffer) || this.timer !== null) {
      return;
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.confirmed) {
        return;
      }
      this.confirmed = true;
      this.buffer = "";
      confirm();
    }, CONFIRM_DELAY_MS);
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export const CLAUDE_FOLDER_TRUST_CONFIRM_KEY = CONFIRM_KEY;
