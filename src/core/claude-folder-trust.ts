import { compactRow as compact, unboxRow as unbox, type ScreenSnapshot } from "./terminal-screen";

/**
 * Claude Code asks whether to trust the workspace before its REPL starts.
 * Trust is not persisted in `$HOME` or some non-git folders, so Head Terminal
 * answers it once per spawn — the pane cwd is a folder the user already
 * picked.
 *
 * The answer has to be *chosen*, not just confirmed: Claude Code 2.1.283
 * paints "❯ No, exit" preselected above "Yes, I trust this folder", and a
 * bare Enter exits Claude and drops the pane to its fallback shell (earlier
 * builds preselected "Yes"). So the rendered screen says which option holds
 * the ❯, the arrow keys move it onto "Yes", and only then Enter confirms.
 *
 * Only the live dialog counts, never its words quoted in a transcript: the
 * options have to be whole option rows (each option a block, since a narrow
 * pane word-wraps "Yes, I trust this" / "folder"), right above the dialog's
 * own "Enter to confirm" footer at the bottom of the screen. Text is compared
 * with every whitespace removed, so a gap painted as cursor moves still reads
 * `yes,itrustthisfolder`.
 */
const YES_PHRASES = ["yes,itrustthisfolder", "yes,proceed"];
const EXIT_PHRASE = "no,exit";
const LEGACY_QUESTION = "doyoutrustthefilesinthisfolder";
const FOOTER = "entertoconfirm";

const SELECTED_MARK = /^\s*[❯>]/u;
/** An option row: the selection marker, an optional number, "Yes,"/"No,". */
const OPTION_START = /^[❯>]?(?:\d+\.)?(?:yes,|no,)/u;
/** The footer wraps into up to four rows in a pane ten columns wide. */
const FOOTER_ROWS = 4;
/** The options and the footer are the last thing on screen, however narrow
 * the pane: at ten columns they still fit in about a dozen rows. */
const OPTION_ROWS = 12;

export const CLAUDE_FOLDER_TRUST_CONFIRM_KEY = "\r";
export const CLAUDE_FOLDER_TRUST_DOWN_KEY = "\x1b[B";
export const CLAUDE_FOLDER_TRUST_UP_KEY = "\x1b[A";

/** How long "Yes" must stay selected, with the screen still, before Enter.
 * Claude repaints the dialog once more when its terminal queries (CSI >0q,
 * CSI ?u — xterm.js answers neither) time out, and that repaint snaps the
 * selection back to "No, exit": 98–169 ms after the "Yes" frame over 27 real
 * spawns, later under load, plus the frame the pty writer holds bytes for.
 * Every frame while waiting starts the pause over, and the screen is read
 * again just before confirming. */
const CONFIRM_DELAY_MS = 350;
/** A dialog that keeps repainting with "Yes" selected is confirmed anyway
 * once "Yes" held this long — well past the one repaint that snaps back. */
const CONFIRM_MAX_WAIT_MS = 2000;
/** An arrow key can be lost while the TUI is still entering raw mode: when
 * the selection has not moved by then, the key is sent again. */
const MOVE_RETRY_MS = 400;
/** The trust dialog is the first thing Claude shows. Past this long after
 * the spawn's first frame there is no dialog left to answer, and a watcher
 * still armed could only ever type into the live REPL. */
const WATCH_WINDOW_MS = 30_000;
const MAX_MOVES = 5;

function indentOf(row: string): number {
  return /^\s*/u.exec(row)?.[0].length ?? 0;
}

/** Where an option's label starts, past the marker and the number: the
 * column its wrapped continuation rows are indented to. */
function labelColumn(row: string): number {
  return /^\s*(?:[❯>]\s*)?(?:\d+\.\s*)?/u.exec(row)?.[0].length ?? 0;
}

interface OptionBlock {
  /** Index of the option's first row, the one the ❯ is drawn on. */
  start: number;
  /** The whole option, rows joined and compacted. */
  text: string;
}

/** The options among `rows`, each with the rows it wrapped onto. */
function optionBlocks(rows: string[]): OptionBlock[] {
  const blocks: OptionBlock[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!OPTION_START.test(compact(row))) {
      continue;
    }
    const column = labelColumn(row);
    let text = compact(row);
    let next = index + 1;
    // A continuation is indented to the label and is not the next option,
    // nor the footer (" Enter to confirm", indented less).
    while (
      next < rows.length &&
      rows[next].trim() &&
      indentOf(rows[next]) >= column &&
      !OPTION_START.test(compact(rows[next]))
    ) {
      text += compact(rows[next]);
      next += 1;
    }
    blocks.push({ start: index, text });
    index = next - 1;
  }
  return blocks;
}

/** An option that is exactly `phrase`, give or take its marker and number. */
function isOption(block: OptionBlock, phrase: string): boolean {
  return block.text.replace(/^[❯>]?(?:\d+\.)?/u, "") === phrase;
}

export interface FolderTrustPrompt {
  /** Which option holds the selection marker, if any row shows one. */
  selected: "yes" | "no" | null;
  /** The "Yes" option sits above the selected row (arrow up reaches it). */
  yesAbove: boolean;
}

/** The workspace trust dialog, when it is live on screen. */
export function parseClaudeFolderTrust(snapshot: ScreenSnapshot): FolderTrustPrompt | null {
  const rows = snapshot.rows.map(unbox).filter((row) => row.trim());
  const footer = rows.slice(-FOOTER_ROWS).map(compact).join("");
  if (!footer.includes(FOOTER)) {
    return null;
  }

  const blocks = optionBlocks(rows.slice(-OPTION_ROWS));
  const exit = blocks.find((block) => isOption(block, EXIT_PHRASE));
  const yes = blocks.find((block) => YES_PHRASES.some((phrase) => isOption(block, phrase)));
  if (!exit || !yes) {
    return null;
  }
  // "Yes, proceed" alone is too generic: on older builds it only counts
  // under their "Do you trust the files in this folder?" heading, which may
  // have wrapped too.
  const trusts =
    isOption(yes, YES_PHRASES[0]) || rows.map(compact).join("").includes(LEGACY_QUESTION);
  if (!trusts) {
    return null;
  }

  const tail = rows.slice(-OPTION_ROWS);
  const selected = [yes, exit].find((block) => SELECTED_MARK.test(tail[block.start]));
  return {
    selected: selected === yes ? "yes" : selected === exit ? "no" : null,
    yesAbove: selected !== undefined && yes.start < selected.start,
  };
}

/**
 * Watches a Claude Code pane and answers the workspace trust dialog with
 * "Yes". One shot per spawn: later numbered prompts are left for the user,
 * and the watch ends for good once the REPL is up (`isAgentUp`, or a Claude
 * status title — see stop()) or WATCH_WINDOW_MS after the first frame,
 * whichever comes first. `check()` runs after every parsed frame; retries
 * re-read the screen on their own, since a lost key produces no frame at all.
 */
export class ClaudeFolderTrustAutoAccept {
  private done = false;
  private moves = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private waitingFor: "move" | "confirm" | null = null;
  private firstCheckAt: number | null = null;
  /** Since when "Yes" has held, while waiting to confirm. */
  private yesSince = 0;

  constructor(
    private readonly options: {
      readScreen: () => ScreenSnapshot;
      send: (keys: string) => void;
      /** The screen shows Claude's REPL (its input box, its working
       * footer): the dialog, if there was one, is behind us. */
      isAgentUp?: (snapshot: ScreenSnapshot) => boolean;
      onAccepted?: () => void;
      onGaveUp?: () => void;
    },
  ) {}

  check(): void {
    if (this.done) {
      return;
    }
    const now = Date.now();
    this.firstCheckAt ??= now;
    if (now - this.firstCheckAt > WATCH_WINDOW_MS) {
      this.stop();
      return;
    }
    const screen = this.options.readScreen();
    if (this.options.isAgentUp?.(screen)) {
      this.stop();
      return;
    }
    const prompt = parseClaudeFolderTrust(screen);
    const confirming = this.waitingFor === "confirm";

    if (prompt?.selected === "yes") {
      // The move landed (or "Yes" came preselected): no need to wait for
      // the retry any longer. A frame while waiting to confirm starts the
      // pause over — "Yes" has to hold on a still screen.
      if (!confirming) {
        this.yesSince = now;
      } else if (now - this.yesSince >= CONFIRM_MAX_WAIT_MS) {
        return;
      }
      this.dispose();
      this.arm("confirm", CONFIRM_DELAY_MS, () => this.confirm());
      return;
    }

    if (confirming) {
      // "Yes" did not hold (Claude's repaint snapped the selection back, or
      // the dialog is mid-repaint): no Enter for it. Move again if need be.
      this.dispose();
    }
    if (!prompt) {
      return;
    }
    if (this.waitingFor === "move") {
      return;
    }
    if (this.moves >= MAX_MOVES) {
      this.stop();
      this.options.onGaveUp?.();
      return;
    }
    this.moves += 1;
    this.options.send(prompt.yesAbove ? CLAUDE_FOLDER_TRUST_UP_KEY : CLAUDE_FOLDER_TRUST_DOWN_KEY);
    this.arm("move", MOVE_RETRY_MS, () => this.check());
  }

  /** "Yes" held through the pause: confirm, after one last look. */
  private confirm(): void {
    if (parseClaudeFolderTrust(this.options.readScreen())?.selected !== "yes") {
      this.check();
      return;
    }
    this.done = true;
    this.options.send(CLAUDE_FOLDER_TRUST_CONFIRM_KEY);
    this.options.onAccepted?.();
  }

  private arm(kind: "move" | "confirm", delay: number, run: () => void): void {
    this.waitingFor = kind;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.waitingFor = null;
      if (!this.done) {
        run();
      }
    }, delay);
  }

  /** The dialog is behind us (the agent is up): stop watching. */
  stop(): void {
    this.done = true;
    this.dispose();
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.waitingFor = null;
  }
}
