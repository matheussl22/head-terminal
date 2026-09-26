import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneActivity, PaneBlock } from "../types/activity";
import type { AgentHookEvent } from "../types/agent-hooks";
import { ActivityDetector } from "./activity-detector";
import {
  readTerminalScreen,
  SpawnScreenReader,
  type ScreenSnapshot,
  type ScreenSource,
} from "./terminal-screen";

const RULE = "─".repeat(80);

const CLAUDE_IDLE = [
  "● OK",
  "",
  "✻ Worked for 4s · done 22:05",
  RULE,
  "❯ ",
  RULE,
  "  ⏸ manual mode on · ? for shortcuts · ← for agents",
];
const CLAUDE_TYPING = [RULE, "❯ hello", RULE, "  ⏸ manual mode on"];
const CLAUDE_WORKING = [
  "✶ Wibbling… (3s · ↓ 181 tokens · thought for 1s)",
  RULE,
  "❯ ",
  RULE,
  "  ⏸ manual mode on · esc to interrupt · ← for agents",
];
const CLAUDE_PERMISSION = [
  "● Write(probe.txt)",
  RULE,
  " Create file",
  " probe.txt",
  " Do you want to create probe.txt?",
  " ❯ 1. Yes",
  "   2. Yes, and switch to accept edits (shift+tab)",
  "   3. No",
  "",
  " Esc to cancel · Tab to amend",
];
const CLAUDE_QUESTION = [
  RULE,
  " ☐ Color ",
  "Pick a color",
  "❯ 1. Red",
  "  2. Blue",
  "  3. Type something.",
  "  4. Chat about this",
  "Enter to select · ↑/↓ to navigate · Esc to cancel",
];
const CLAUDE_TRUST = [
  " Quick safety check: Is this a project you created or one you trust?",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
];
const CLAUDE_DECLINED = [
  "● Write(probe.txt)",
  "  ⎿  User rejected write to probe.txt",
  "✻ Sautéed for 3s · done 22:05",
  RULE,
  "❯ ",
  RULE,
  "  ⏸ manual mode on · ? for shortcuts · ← for agents",
];

const CODEX_IDLE = ["• OK", "", "› Ask Codex to do anything", "", "  gpt-5.6-luna low · ~\\work-a"];
const CODEX_COMMAND = [
  "  Would you like to run the following command?",
  "  $ New-Item -ItemType Directory probe_dir",
  "› 1. Yes, proceed (y)",
  "  3. No, and tell Codex what to do differently (esc)",
  "",
  "  Press enter to confirm or esc to cancel",
];
const CODEX_UPDATE = [
  "  ✨ Update available! 0.155.1 -> 0.156.1",
  "› 1. Update now",
  "  2. Skip",
  "  3. Skip until next version",
  "",
  "  Press enter to continue",
];

interface Change {
  activity: PaneActivity;
  blocked?: PaneBlock;
  source: string;
  agentExitCode?: number;
}

function hook(event: string, extra: Partial<AgentHookEvent> = {}): AgentHookEvent {
  return { paneId: "p", source: "claude", event, receivedAt: 0, ...extra };
}

function setup(agentProfileId: string) {
  let snapshot: ScreenSnapshot = { rows: [], cursorLine: "", altScreen: false };
  const changes: Change[] = [];
  const detector = new ActivityDetector({
    agentProfileId,
    readScreen: () => snapshot,
    onChange: (activity, blocked, meta) => {
      changes.push({ activity, blocked, source: meta.source, agentExitCode: meta.agentExitCode });
    },
  });
  detector.onStarting();
  detector.onRunning();

  const pane = {
    detector,
    changes,
    get activity() {
      return detector.activity;
    },
    get blocked() {
      return detector.blocked;
    },
    screen(rows: string[], cursorLine = "", altScreen = false) {
      snapshot = { rows, cursorLine, altScreen };
    },
    /** New output: the screen changes and xterm reports a parsed frame. */
    frame(rows?: string[], cursorLine = "") {
      if (rows) {
        pane.screen(rows, cursorLine);
      }
      detector.onFrame();
    },
    /** A frame whose screen was read from a (fake) terminal. */
    frameSnapshot(next: ScreenSnapshot) {
      snapshot = next;
      detector.onFrame();
    },
    title(text: string) {
      detector.onTitle(text);
      vi.advanceTimersByTime(0);
    },
    input(data: string) {
      detector.onUserInput(data);
    },
    advance(ms: number) {
      vi.advanceTimersByTime(ms);
    },
    activities() {
      return changes.map((change) => change.activity);
    },
  };
  return pane;
}

/** A Claude pane that is up and idle at its prompt. */
function readyClaude() {
  const pane = setup("claude");
  pane.frame(CLAUDE_IDLE);
  pane.title("✳ Claude Code");
  pane.advance(2000);
  expect(pane.activity).toBe("idle");
  return pane;
}

function readyCodex() {
  const pane = setup("codex");
  pane.frame(CODEX_IDLE);
  pane.title("work-a");
  pane.advance(2000);
  expect(pane.activity).toBe("idle");
  return pane;
}

function readyShell(profile = "shell") {
  const pane = setup(profile);
  pane.frame(["PS C:\\Users\\mathe> "], "PS C:\\Users\\mathe> ");
  pane.advance(300);
  expect(pane.activity).toBe("idle");
  return pane;
}

/** An ollama pane at its ">>> " prompt. */
function readyOllama() {
  const pane = setup("ollama");
  pane.frame([">>> Send a message (/? for help)"], ">>> ");
  pane.advance(300);
  expect(pane.activity).toBe("idle");
  return pane;
}

/** A terminal `rows` tall showing `lines` from its top, the rest blank, as
 * a fresh pane shows an inline TUI (see terminal-screen.ts). */
function tallScreen(lines: string[], rows = 57, cursor = { x: 0, y: lines.length - 1 }): ScreenSnapshot {
  const buffer = [...lines, ...Array<string>(rows - lines.length).fill("")];
  return readTerminalScreen({
    rows,
    buffer: {
      active: {
        type: "normal",
        baseY: 0,
        cursorX: cursor.x,
        cursorY: cursor.y,
        getLine: (y: number) => ({
          translateToString: (trimRight?: boolean, start = 0, end?: number) => {
            const text = (buffer[y] ?? "").slice(start, end);
            return trimRight ? text.replace(/\s+$/u, "") : text;
          },
        }),
      },
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ActivityDetector: Claude Code", () => {
  it("stays starting until Claude's status title, without flashing the trust dialog", () => {
    const pane = setup("claude");
    pane.title("claude");
    pane.frame(CLAUDE_TRUST);
    pane.advance(600);
    // The auto-accept answered it; Claude comes up.
    pane.frame(CLAUDE_IDLE);
    pane.advance(500);
    expect(pane.activity).toBe("starting");

    pane.title("✳ Claude Code");
    pane.advance(2000);

    expect(pane.activities()).toEqual(["idle"]);
  });

  it("shows the trust dialog as waiting when nobody answers it", () => {
    const pane = setup("claude");
    pane.frame(CLAUDE_TRUST);
    pane.advance(1900);
    expect(pane.activity).toBe("starting");

    pane.advance(300);
    expect(pane.activity).toBe("waiting_input");
    expect(pane.blocked).toEqual({ reason: "dialog" });
  });

  it("never flips an idle pane for typing, resizes, mouse or silence", () => {
    const pane = readyClaude();
    for (const key of ["h", "e", "l", "l", "o", "\x7f", "\x15", "\x1b[<64;40;10M", "\x1b[<0;40;10M", "\x1b[B"]) {
      pane.input(key);
      pane.frame(CLAUDE_TYPING);
      pane.advance(300);
    }
    // A resize repaints the whole screen.
    pane.frame(CLAUDE_IDLE);
    pane.frame(CLAUDE_IDLE);
    pane.advance(70_000);

    expect(pane.activities()).toEqual(["idle"]);
  });

  it("goes working on the spinner title and back to idle when the turn ends", () => {
    const pane = readyClaude();
    pane.input("\r");
    pane.title("◐ Claude Code");
    expect(pane.activity).toBe("working");

    for (const glyph of ["◑", "◐", "◑"]) {
      pane.frame(CLAUDE_WORKING);
      pane.title(`${glyph} Reply with OK`);
      pane.advance(900);
    }
    pane.frame(CLAUDE_IDLE);
    pane.title("✳ Reply with OK");
    expect(pane.activity).toBe("working");
    pane.advance(250);

    expect(pane.activity).toBe("idle");
    expect(pane.activities()).toEqual(["idle", "working", "idle"]);
  });

  it("stays working through a long silent tool while the title keeps spinning", () => {
    const pane = readyClaude();
    pane.title("◐ Sleep command test");
    for (let second = 0; second < 12; second += 1) {
      pane.advance(960);
      pane.title(second % 2 ? "◐ Sleep command test" : "◑ Sleep command test");
    }
    expect(pane.activity).toBe("working");
  });

  it("waits on a permission dialog and goes idle when it is declined with Esc", () => {
    const pane = readyClaude();
    pane.title("◐ Ok");
    pane.detector.onHookEvent(hook("PreToolUse", { toolName: "Write" }));
    pane.detector.onHookEvent(hook("PermissionRequest", { toolName: "Write" }));
    // The hook lands ~120 ms before the title flips: still working.
    expect(pane.activity).toBe("working");

    pane.frame(CLAUDE_PERMISSION);
    pane.title("✳ Ok");
    expect(pane.activity).toBe("waiting_input");
    expect(pane.blocked).toEqual({ reason: "approval", detail: "Write" });

    // Ten silent seconds: still waiting, silence proves nothing.
    pane.advance(10_000);
    expect(pane.activity).toBe("waiting_input");

    // Declining fires no hook at all.
    pane.input("\x1b");
    pane.frame(CLAUDE_DECLINED);
    pane.advance(500);

    expect(pane.activity).toBe("idle");
    expect(pane.activities()).toEqual(["idle", "working", "waiting_input", "idle"]);
  });

  it("waits on a dialog only the hook knows about until the user answers it", () => {
    const pane = readyClaude();
    pane.title("◐ Ok");
    pane.detector.onHookEvent(hook("PermissionRequest", { toolName: "Bash" }));
    pane.frame(["  some dialog variant the screen patterns do not know"]);
    pane.title("✳ Ok");
    expect(pane.blocked).toEqual({ reason: "approval", detail: "Bash" });

    pane.advance(30_000);
    expect(pane.activity).toBe("waiting_input");

    pane.input("\x1b");
    pane.frame(CLAUDE_IDLE);
    pane.advance(1300);
    expect(pane.activity).toBe("idle");
  });

  it("waits on a dialog without hooks, from the screen alone", () => {
    const pane = readyClaude();
    pane.title("◐ Ok");
    pane.frame(CLAUDE_PERMISSION);
    pane.title("✳ Ok");
    pane.advance(100);
    expect(pane.activity).toBe("waiting_input");
    expect(pane.blocked).toEqual({ reason: "approval", detail: "Write" });

    pane.input("\x1b");
    pane.frame(CLAUDE_DECLINED);
    pane.advance(150);
    expect(pane.activity).toBe("idle");
  });

  it("reads AskUserQuestion as a question and goes back to work once answered", () => {
    const pane = readyClaude();
    pane.title("◐ Ok");
    pane.detector.onHookEvent(hook("PermissionRequest", { toolName: "AskUserQuestion" }));
    pane.frame(CLAUDE_QUESTION);
    pane.title("✳ Ok");
    expect(pane.blocked).toEqual({ reason: "question" });

    // The reminder six seconds in must not turn the question into an approval.
    pane.detector.onHookEvent(hook("Notification", { notificationType: "permission_prompt" }));
    expect(pane.blocked).toEqual({ reason: "question" });

    pane.input("\r");
    pane.frame(CLAUDE_WORKING);
    pane.title("◐ Ok");
    pane.advance(200);
    expect(pane.activity).toBe("working");

    pane.detector.onHookEvent(hook("PostToolUse", { toolName: "AskUserQuestion" }));
    pane.detector.onHookEvent(hook("Stop"));
    pane.frame(CLAUDE_IDLE);
    pane.title("✳ Ok");
    pane.advance(250);
    expect(pane.activity).toBe("idle");
  });

  it("approving a permission goes straight back to work", () => {
    const pane = readyClaude();
    pane.title("◐ Ok");
    pane.detector.onHookEvent(hook("PermissionRequest", { toolName: "Bash" }));
    pane.frame(CLAUDE_PERMISSION);
    pane.title("✳ Ok");
    expect(pane.activity).toBe("waiting_input");

    pane.input("\r");
    pane.frame(CLAUDE_WORKING);
    pane.title("◐ Ok");
    pane.advance(200);
    expect(pane.activity).toBe("working");
    // The tool runs for a while; the stale block never resurfaces.
    pane.advance(5000);
    expect(pane.activity).toBe("working");
  });

  it("goes idle when interrupted with Esc, although no Stop hook fires", () => {
    const pane = readyClaude();
    pane.detector.onHookEvent(hook("UserPromptSubmit"));
    pane.title("◐ Ok");
    pane.input("\x1b");
    pane.frame(["  ⎿  Interrupted · What should Claude do instead?", ...CLAUDE_IDLE.slice(3)]);
    pane.title("✳ Ok");
    pane.advance(250);
    expect(pane.activity).toBe("idle");
  });

  it("stays idle when idle_prompt and the internal SubagentStop arrive after a turn", () => {
    const pane = readyClaude();
    pane.detector.onHookEvent(hook("SubagentStop", { agentType: "" }));
    pane.advance(60_000);
    pane.detector.onHookEvent(hook("Notification", { notificationType: "idle_prompt" }));
    pane.advance(1000);
    expect(pane.activities()).toEqual(["idle"]);
  });

  it("falls back to the screen when Claude sets no title at all", () => {
    const pane = setup("claude");
    pane.frame(CLAUDE_IDLE);
    pane.advance(2000);
    expect(pane.activity).toBe("idle");

    pane.input("\r");
    pane.frame(CLAUDE_WORKING);
    pane.advance(150);
    expect(pane.activity).toBe("working");

    pane.frame(CLAUDE_IDLE);
    pane.advance(400);
    expect(pane.activity).toBe("idle");
  });

  it("trusts the title over the screen once Claude sets one", () => {
    const pane = readyClaude();
    // "esc to interrupt" left in view does not make an idle Claude work.
    pane.frame(CLAUDE_WORKING);
    pane.advance(500);
    expect(pane.activity).toBe("idle");
  });

  // The real app, a 57-row pane: the pre-REPL trust dialog is drawn on rows
  // 2–16 of the normal buffer and everything under it is blank.
  const CLAUDE_TRUST_TALL = [
    "",
    "",
    " Accessing workspace:",
    "",
    " C:\\Users\\mathe\\proj",
    "",
    " Quick safety check: Is this a project you created or one you trust?",
    "",
    " Claude Code'll be able to read, edit, and execute files here.",
    "",
    " Security guide",
    "",
    " ❯ No, exit",
    "   Yes, I trust this folder",
    "",
    " Enter to confirm · Esc to cancel",
    "",
  ];

  it("recognizes the trust dialog drawn at the top of a tall pane", () => {
    const pane = setup("claude");
    pane.title("claude");
    pane.frameSnapshot(tallScreen(CLAUDE_TRUST_TALL, 57, { x: 33, y: 15 }));
    pane.advance(1900);
    expect(pane.activity).toBe("starting");
    pane.advance(300);
    expect(pane.activity).toBe("waiting_input");
    expect(pane.blocked).toEqual({ reason: "dialog" });
  });

  it("still graces a trust dialog drawn after the safety net let the pane out of starting", () => {
    const pane = setup("claude");
    // ConPTY's spawn frame, then nothing while Claude boots.
    pane.frame([""]);
    pane.advance(5100 + 1600);
    expect(pane.activity).toBe("idle");

    // The dialog shows up late and the auto-accept answers it.
    pane.frame(CLAUDE_TRUST);
    pane.advance(600);
    pane.frame(CLAUDE_IDLE);
    pane.title("✳ Claude Code");
    pane.advance(2000);
    expect(pane.activities()).toEqual(["idle"]);

    // Nobody answers it: shown once the grace is over.
    const unanswered = setup("claude");
    unanswered.frame([""]);
    unanswered.advance(5100 + 1600);
    unanswered.frame(CLAUDE_TRUST);
    unanswered.advance(1900);
    expect(unanswered.activity).toBe("idle");
    unanswered.advance(300);
    expect(unanswered.activity).toBe("waiting_input");
    expect(unanswered.blocked).toEqual({ reason: "dialog" });
  });

  it("stays idle when a finished turn quotes the trust dialog or a plan question", () => {
    const pane = readyClaude();
    pane.frame([
      "● Na 2.1.283 o dialog mostra \"❯ No, exit\" pré-selecionado e \"Yes, I trust this folder\"",
      "❯ 1. Crie o endpoint /health  2. Escreva os testes",
      "  Would you like to proceed?",
      ...CLAUDE_IDLE.slice(2),
    ]);
    pane.advance(1000);
    // And the user typing "1. sim" into the box under it.
    pane.input("1");
    pane.frame(["  Would you like to proceed?", RULE, "❯ 1. sim", RULE, "  ⏸ manual mode on"]);
    pane.advance(1000);
    expect(pane.activities()).toEqual(["idle"]);
  });

  it("keeps following a session named like a file (Deploy mysite.com)", () => {
    const pane = readyClaude();
    pane.input("\r");
    pane.title("◐ Deploy mysite.com");
    expect(pane.activity).toBe("working");
    pane.frame(CLAUDE_IDLE);
    pane.title("✳ Deploy mysite.com");
    pane.advance(250);
    expect(pane.activity).toBe("idle");

    pane.input("\r");
    pane.title("◑ Deploy mysite.com");
    expect(pane.activity).toBe("working");
    pane.title("✳ Deploy mysite.com");
    pane.advance(250);
    expect(pane.activities()).toEqual(["idle", "working", "idle", "working", "idle"]);
  });

  describe("with hooks but no status title", () => {
    function hookedClaude() {
      const pane = setup("claude");
      pane.frame(CLAUDE_IDLE);
      pane.advance(2000);
      expect(pane.activity).toBe("idle");
      return pane;
    }

    it("goes idle after an Esc interrupt, although no Stop hook comes", () => {
      const pane = hookedClaude();
      pane.input("\r");
      pane.detector.onHookEvent(hook("UserPromptSubmit"));
      pane.frame(CLAUDE_WORKING);
      pane.advance(150);
      expect(pane.activity).toBe("working");

      pane.input("\x1b");
      pane.frame(["  ⎿  Interrupted · What should Claude do instead?", ...CLAUDE_IDLE.slice(3)]);
      pane.advance(400);
      expect(pane.activity).toBe("idle");
      // A screen the patterns cannot read later does not bring the turn back.
      pane.advance(1300);
      pane.frame(["  something the screen patterns do not know"]);
      pane.advance(65_000);
      expect(pane.activities()).toEqual(["idle", "working", "idle"]);
    });

    it("goes idle after a permission is declined with Esc", () => {
      const pane = hookedClaude();
      pane.input("\r");
      pane.detector.onHookEvent(hook("UserPromptSubmit"));
      pane.detector.onHookEvent(hook("PreToolUse", { toolName: "Write" }));
      pane.detector.onHookEvent(hook("PermissionRequest", { toolName: "Write" }));
      pane.frame(CLAUDE_PERMISSION);
      pane.advance(100);
      expect(pane.blocked).toEqual({ reason: "approval", detail: "Write" });

      pane.input("\x1b");
      pane.frame(CLAUDE_DECLINED);
      pane.advance(2000);
      expect(pane.activity).toBe("idle");
    });

    it("stays working through a long tool the user approved", () => {
      const pane = hookedClaude();
      pane.input("\r");
      pane.detector.onHookEvent(hook("UserPromptSubmit"));
      pane.detector.onHookEvent(hook("PreToolUse", { toolName: "Bash" }));
      pane.detector.onHookEvent(hook("PermissionRequest", { toolName: "Bash" }));
      pane.frame(CLAUDE_PERMISSION);
      pane.advance(100);
      pane.input("\r");
      pane.frame(CLAUDE_WORKING);
      pane.advance(15_000);
      expect(pane.activity).toBe("working");
      pane.detector.onHookEvent(hook("PostToolUse", { toolName: "Bash" }));
      pane.detector.onHookEvent(hook("Stop"));
      pane.frame(CLAUDE_IDLE);
      pane.advance(400);
      expect(pane.activity).toBe("idle");
    });
  });
});

describe("ActivityDetector: codex", () => {
  it("reads the spinner while MCP servers boot as starting, not working", () => {
    const pane = setup("codex");
    pane.title("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    pane.frame(CODEX_IDLE);
    pane.title("work-a");
    pane.advance(1000);
    pane.title("⠙ work-a");
    pane.advance(5000);
    pane.title("⠹ work-a");
    expect(pane.activity).toBe("starting");

    pane.title("work-a");
    pane.advance(1600);
    expect(pane.activities()).toEqual(["idle"]);
  });

  it("works on a submitted prompt and waits on an approval with its kind", () => {
    const pane = readyCodex();
    pane.input("\r");
    pane.title("⠧ work-a");
    expect(pane.activity).toBe("working");
    pane.title("⠸ renaming... ⠸ | work-a");
    pane.frame(CODEX_COMMAND);
    pane.title("[ ! ] Action Required | Reply OK | work-a");
    expect(pane.activity).toBe("waiting_input");
    expect(pane.blocked).toEqual({ reason: "approval", detail: "comando" });

    // The title blinks once a second while it waits.
    pane.title("[ . ] Action Required | Reply OK | work-a");
    pane.advance(1000);
    expect(pane.activities()).toEqual(["idle", "working", "waiting_input"]);

    // Decline: one spinner frame, then the plain title.
    pane.input("\x1b");
    pane.title("⠹ Reply OK | work-a");
    pane.frame(CODEX_IDLE);
    pane.title("Reply OK | work-a");
    pane.advance(300);
    expect(pane.activities()).toEqual(["idle", "working", "waiting_input", "idle"]);
  });

  it("gives a reason-less Action Required a moment to show its dialog", () => {
    const pane = readyCodex();
    pane.input("\r");
    pane.title("Working ⠋");
    pane.title("[ ! ] Action Required");
    expect(pane.activity).toBe("working");

    pane.frame([
      "  Question 1/1 (1 unanswered)",
      "  › 1. Red",
      "  tab to add notes | enter to submit answer | esc to interrupt",
    ]);
    pane.advance(100);
    expect(pane.activity).toBe("waiting_input");
    expect(pane.blocked).toEqual({ reason: "question" });
    expect(pane.changes.filter((change) => change.activity === "waiting_input")).toHaveLength(1);
  });

  it("still reports an Action Required whose dialog it cannot read", () => {
    const pane = readyCodex();
    pane.input("\r");
    pane.title("⠋ work-a");
    pane.title("[ ! ] Action Required | work-a");
    pane.advance(200);
    expect(pane.activity).toBe("waiting_input");
    expect(pane.blocked).toEqual({ reason: "approval" });
  });

  it("reads a startup screen that never touches the title as a confirmation", () => {
    const pane = setup("codex");
    pane.frame(CODEX_UPDATE);
    pane.advance(1000);
    expect(pane.activity).toBe("starting");
    pane.advance(1200);
    expect(pane.activity).toBe("waiting_input");
    expect(pane.blocked).toEqual({ reason: "dialog" });
  });
});

describe("ActivityDetector: cursor-agent", () => {
  const CURSOR_IDLE = ["  Cursor Agent", "  → Plan, search, build anything", "  Grok 4.7 · MAX"];
  const CURSOR_WORKING = [" ⠠⠜ Working  16 tokens", "  → Add a follow-up        ctrl+c to stop"];
  const CURSOR_DONE = ["  OK", "  → Add a follow-up", "  Grok 4.7 · MAX · 3.4%"];

  it("reads the screen when its title carries no status", () => {
    const pane = setup("cursor");
    pane.frame(CURSOR_IDLE);
    pane.title("Cursor Agent");
    pane.advance(2000);
    expect(pane.activity).toBe("idle");

    pane.input("\r");
    pane.frame(CURSOR_WORKING);
    pane.title("Just OK");
    pane.advance(150);
    expect(pane.activity).toBe("working");

    pane.frame(CURSOR_DONE);
    pane.advance(400);
    expect(pane.activities()).toEqual(["idle", "working", "idle"]);
  });

  it("reads the trust dialog and the spinner cursor draws at the top of a tall pane", () => {
    const pane = setup("cursor");
    const trust = [
      "  ╭──────────────────────────────────────────────────╮",
      "  │  ⚠ Workspace Trust Required                      │",
      "  │  Do you trust the contents of this directory?    │",
      "  │  ▶ [a] Trust this workspace                      │",
      "  │    [q] Quit                                      │",
      "  │  Use arrow keys to navigate, Enter to select     │",
      "  ╰──────────────────────────────────────────────────╯",
    ];
    pane.frameSnapshot(tallScreen(trust, 57, { x: 0, y: 56 }));
    pane.advance(2200);
    expect(pane.activity).toBe("waiting_input");
    expect(pane.blocked).toEqual({ reason: "dialog" });

    pane.input("a");
    pane.frameSnapshot(tallScreen(CURSOR_IDLE, 57, { x: 4, y: 1 }));
    pane.title("Cursor Agent");
    pane.advance(2000);
    expect(pane.activity).toBe("idle");

    pane.input("\r");
    pane.frameSnapshot(tallScreen(["  Reply with just the word OK.", ...CURSOR_WORKING], 57, { x: 4, y: 2 }));
    pane.advance(150);
    expect(pane.activity).toBe("working");
  });

  it("does not take the Reconnecting spinner after a finished turn for work", () => {
    // cursor-cap/runB with the status indicators off (the user's config).
    const pane = setup("cursor");
    pane.frame(CURSOR_IDLE);
    pane.title("Cursor Agent");
    pane.advance(2000);
    pane.input("\r");
    pane.frame(CURSOR_WORKING);
    pane.advance(150);
    pane.frame(CURSOR_DONE);
    pane.advance(400);
    for (const attempt of [1, 2, 3]) {
      pane.frame([`  OK`, ` ⠘⠆ Reconnecting (attempt ${attempt}, 1s)`, "  → Add a follow-up", "  Grok 4.7 · MAX · 3.4%"]);
      pane.advance(3000);
      pane.frame(CURSOR_DONE);
      pane.advance(5000);
    }
    expect(pane.activities()).toEqual(["idle", "working", "idle"]);
  });

  it("follows the status indicators when they are on", () => {
    const pane = setup("cursor");
    pane.frame(CURSOR_IDLE);
    pane.title("Cursor Agent - ✅ Ready");
    pane.advance(2000);
    pane.title("Just OK - ⏳ Working ···");
    expect(pane.activity).toBe("working");
    pane.title("Just OK - 🔐 Waiting for confirmation");
    expect(pane.blocked).toEqual({ reason: "approval" });
    pane.title("Just OK - ✅ Ready");
    pane.advance(10);
    // Reconnecting says nothing new about the turn.
    pane.title("Just OK - 🔄 Reconnecting");
    pane.advance(1000);
    expect(pane.activity).toBe("idle");
    expect(pane.activities()).toEqual(["idle", "working", "waiting_input", "idle"]);
  });
});

describe("ActivityDetector: shells", () => {
  it("comes up once its prompt shows", () => {
    const pane = setup("shell");
    pane.frame(["PS C:\\Users\\mathe> "], "PS C:\\Users\\mathe> ");
    pane.advance(100);
    expect(pane.activity).toBe("starting");
    pane.advance(200);
    expect(pane.activity).toBe("idle");
  });

  it("works from Enter until the prompt comes back", () => {
    const pane = readyShell();
    pane.input("n");
    pane.input("p");
    pane.frame(["PS C:\\Users\\mathe> np"], "PS C:\\Users\\mathe> np");
    pane.advance(1000);
    expect(pane.activity).toBe("idle");

    pane.input("\r");
    expect(pane.activity).toBe("working");
    pane.frame(["PS C:\\Users\\mathe> npm test", "> vitest run"], "");
    pane.advance(5000);
    expect(pane.activity).toBe("working");

    pane.frame(["Tests 12 passed", "PS C:\\Users\\mathe> "], "PS C:\\Users\\mathe> ");
    pane.advance(300);
    expect(pane.activities()).toEqual(["idle", "working", "idle"]);
  });

  it("keeps a long silent command working", () => {
    const pane = readyShell();
    pane.input("sleep 30\r");
    pane.frame(["PS C:\\Users\\mathe> sleep 30", ""], "");
    pane.advance(29_000);
    expect(pane.activity).toBe("working");
  });

  it("does not take a '>' in the middle of a stream for a prompt", () => {
    const pane = readyOllama();
    pane.input("write html\r");
    for (let chunk = 0; chunk < 20; chunk += 1) {
      pane.frame(["<div>"], "<div>");
      pane.advance(100);
    }
    expect(pane.activity).toBe("working");
    pane.frame([">>> "], ">>> ");
    // A local model's prompt has to hold still before its turn is over.
    pane.advance(1000);
    expect(pane.activity).toBe("working");
    pane.advance(800);
    expect(pane.activity).toBe("idle");
  });

  it("runs nothing on Enter at a bare prompt", () => {
    const pane = readyShell();
    pane.input("\r");
    expect(pane.activities()).toEqual(["idle"]);
  });

  it("stays idle after a multi-line bracketed paste, which runs nothing", () => {
    // scratchpad/rev/paste.cjs: pwsh with PSReadLine only fills its editor.
    const pane = readyShell();
    pane.input("\x1b[200~git status\rgit log -1\x1b[201~");
    pane.frame(["PS C:\\Users\\mathe> git status", ">> git log -1"], ">> git log -1");
    pane.advance(60_000);
    expect(pane.activities()).toEqual(["idle"]);

    // The Enter that follows does run it.
    pane.input("\r");
    expect(pane.activity).toBe("working");
  });

  // oh-my-zsh's default prompt: no $#%>❯ at the end, so it is only known by
  // the symbol it was learned with (scratchpad/rev/omz.cjs, omz2.cjs).
  const OMZ_PROMPT = "➜  proj git:(main) ";

  it("learns a prompt the shell draws after the safety net already let it out", () => {
    const pane = setup("shell");
    pane.frame([""], ""); // ConPTY's spawn frame; the profile loads silently
    pane.advance(2500);
    pane.frame([OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(4000);

    pane.input("git status\r");
    pane.frame([`${OMZ_PROMPT}git status`], "");
    pane.advance(30);
    pane.frame([`${OMZ_PROMPT}git status`, "On branch main", "nothing to commit, working tree clean"], "");
    pane.advance(40);
    pane.frame(["nothing to commit, working tree clean", OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(300);
    expect(pane.activity).toBe("idle");
    expect(pane.activities()).toEqual(["idle", "working", "idle"]);
  });

  it("learns the prompt from a command typed before the shell was ready", () => {
    const pane = setup("shell");
    pane.frame([""], "");
    pane.advance(800);
    pane.frame([OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(1000);
    pane.screen([`${OMZ_PROMPT}git status`], `${OMZ_PROMPT}git status`);
    pane.input("\r");
    expect(pane.activity).toBe("working");
    pane.advance(30);
    pane.frame(["On branch main", "nothing to commit, working tree clean"], "");
    pane.advance(40);
    pane.frame(["nothing to commit, working tree clean", OMZ_PROMPT], OMZ_PROMPT);
    // Not the 20 s safety cap: as soon as the prompt held still.
    pane.advance(300);
    expect(pane.activity).toBe("idle");
  });

  // oh-my-zsh asks "[oh-my-zsh] Would you like to update? [Y/n] " at startup
  // (its default update mode): that line ends in a space and is what a quiet
  // moment learns as the prompt (scratchpad/rev5/omz-update.json).
  const OMZ_UPDATE = "[oh-my-zsh] Would you like to update? [Y/n] ";

  it("re-learns a prompt guessed from an rc question once the real one comes back", () => {
    const pane = setup("shell");
    pane.frame(["Last login: Fri Sep 25 on ttys001", OMZ_UPDATE], OMZ_UPDATE);
    pane.advance(2500);
    expect(pane.activity).toBe("idle");

    pane.input("n");
    pane.frame(["Last login: Fri Sep 25 on ttys001", `${OMZ_UPDATE}n`], `${OMZ_UPDATE}n`);
    pane.input("\r");
    expect(pane.activity).toBe("working");
    pane.advance(20);
    pane.frame([`${OMZ_UPDATE}n`, OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(1000);
    expect(pane.activity).toBe("working");
    pane.advance(300);
    expect(pane.activity).toBe("idle");

    // From then on the real prompt is the one known.
    pane.input("ls");
    pane.frame([OMZ_PROMPT, `${OMZ_PROMPT}ls`], `${OMZ_PROMPT}ls`);
    pane.input("\r");
    pane.advance(20);
    pane.frame([`${OMZ_PROMPT}ls`, "README.md  src", OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(300);
    expect(pane.activities()).toEqual(["idle", "working", "idle", "working", "idle"]);
  });

  it("re-learns the prompt after the first real command when the question took a single key", () => {
    // scratchpad/vef/omz-readk.json: `read -k 1` takes the "n" without Enter.
    const pane = setup("shell");
    pane.frame([OMZ_UPDATE], OMZ_UPDATE);
    pane.advance(2500);
    pane.input("n");
    pane.frame([`${OMZ_UPDATE}n`, "[oh-my-zsh] You can update manually by running `omz update`", OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(2000);
    pane.input("ls\r");
    pane.advance(20);
    pane.frame([`${OMZ_PROMPT}ls`, "README.md  src", OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(1300);
    expect(pane.activity).toBe("idle");
    pane.input("git status\r");
    pane.advance(20);
    pane.frame([`${OMZ_PROMPT}git status`, "clean", OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(300);
    expect(pane.activities()).toEqual(["idle", "working", "idle", "working", "idle"]);
  });

  it("keeps the prompt it confirmed, whatever a later command leaves at the cursor", () => {
    const pane = setup("shell");
    pane.frame([OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(2500);
    pane.input("ls\r");
    pane.advance(20);
    pane.frame([`${OMZ_PROMPT}ls`, "README.md", OMZ_PROMPT], OMZ_PROMPT);
    pane.advance(300);
    expect(pane.activity).toBe("idle");

    // Confirmed: a progress line that pauses on a trailing space is not a
    // prompt to learn, however long it holds.
    pane.input("npm install\r");
    pane.advance(20);
    pane.frame([`${OMZ_PROMPT}npm install`, "⸨░░░░░░⸩ ⠧ idealTree: timing "], "⸨░░░░░░⸩ ⠧ idealTree: timing ");
    pane.advance(5000);
    expect(pane.activity).toBe("working");
  });

  it("sees the PowerShell prompt back with the rest of an unbracketed paste typed on it", () => {
    // e2e T7: pwsh 7.6 + PSReadLine 2.4 leave bracketed paste off, so the
    // first line runs and the prompt returns with "echo line-two" on it.
    const pane = readyShell();
    pane.input("echo line-one\recho line-two");
    expect(pane.activity).toBe("working");
    pane.advance(60);
    pane.frame(
      ["PS C:\\Users\\mathe> echo line-one", "line-one", "PS C:\\Users\\mathe> echo line-two"],
      "PS C:\\Users\\mathe> echo line-two",
    );
    pane.advance(300);
    expect(pane.activity).toBe("idle");

    // What was left typed is a command: Enter runs it.
    pane.input("\r");
    expect(pane.activity).toBe("working");
  });

  it("does not take a command for an empty submit when Enter beats its echo", () => {
    // e2e C: the echo takes 32–62 ms; an Enter right behind the typing
    // reached the pty over a prompt that still looked bare.
    const pane = readyShell();
    pane.input("s");
    pane.input("l");
    pane.input("e");
    pane.input("\r");
    expect(pane.activity).toBe("working");
    pane.advance(60);
    pane.frame(["PS C:\\Users\\mathe> sle", ""], "");
    pane.advance(2000);
    expect(pane.activity).toBe("working");
    pane.frame(["PS C:\\Users\\mathe> sle", "PS C:\\Users\\mathe> "], "PS C:\\Users\\mathe> ");
    pane.advance(300);
    expect(pane.activity).toBe("idle");

    // An Enter with nothing typed since the last one still runs nothing, as
    // does one after Ctrl+C dropped the line.
    pane.input("\r");
    pane.input("x");
    pane.input("\x03");
    pane.input("\r");
    expect(pane.activities()).toEqual(["idle", "working", "idle"]);
  });

  it("keeps a slow local model working through pauses on '=>' until its '>>>' prompt", () => {
    // scratchpad/rev/shell-cases.cjs ollama: ~3 tokens/s on CPU.
    const pane = readyOllama();
    pane.input("write a js arrow fn\r");
    const lines = ["Here is one:", "", "const add = (a, b) =>", "const add = (a, b) => a + b;", "## Usage", "It adds two numbers."];
    for (const line of lines) {
      pane.frame(["write a js arrow fn", line], line);
      pane.advance(320);
      expect(pane.activity, line).toBe("working");
    }
    pane.frame(["It adds two numbers.", "", ">>> Send a message (/? for help)"], ">>> ");
    pane.advance(1800);
    expect(pane.activities()).toEqual(["idle", "working", "idle"]);
  });

  it("keeps working when a slow local model only paused on a lone '>' or '>>>' of its own", () => {
    // scratchpad/rev5/repl-slow.json (qwen27): every pause on a markdown
    // quote or a Python example used to flash "Pronto" — and "Concluído",
    // with a notification, for a pane nobody was watching.
    const pane = readyOllama();
    pane.input("quote Hamlet\r");
    pane.advance(30);
    pane.frame(["quote Hamlet", "Sure:", "> "], "> ");
    pane.advance(600);
    expect(pane.activity).toBe("working");
    pane.frame(["Sure:", "> To be, or not to be"], "> To be, or not to be");
    pane.advance(300);
    pane.frame(["> To be, or not to be", "Python:", ">>>"], ">>>");
    pane.advance(1200);
    expect(pane.activity).toBe("working");
    pane.frame(["Python:", ">>> print(1)"], ">>> print(1)");
    pane.advance(300);
    pane.frame([">>> print(1)", "", ">>> "], ">>> ");
    pane.advance(1000);
    expect(pane.activity).toBe("working");
    pane.advance(800);
    expect(pane.activity).toBe("idle");

    // Typing at its prompt echoes, and is not the model answering.
    pane.input("h");
    pane.frame([">>> h"], ">>> h");
    pane.advance(1000);
    expect(pane.activities()).toEqual(["idle", "working", "idle"]);
  });

  it("is never waiting_input, whatever is on screen", () => {
    const pane = readyShell();
    pane.input("cat notes.txt\r");
    pane.frame(["Do you want to proceed?", "❯ 1. Yes", "Esc to cancel · Tab to amend"], "");
    pane.advance(10_000);
    expect(pane.activity).toBe("working");
  });

  it("becomes idle when nothing it recognizes ever shows up", () => {
    const pane = setup("antigravity");
    pane.frame(["Welcome to a TUI with no prompt"], "");
    pane.advance(1900);
    expect(pane.activity).toBe("starting");
    pane.advance(200);
    expect(pane.activity).toBe("idle");
  });

  it("gives agents longer before the safety net, and never says working by default", () => {
    const pane = setup("claude");
    pane.frame(["loading…"], "");
    pane.advance(4000);
    expect(pane.activity).toBe("starting");
    pane.advance(1200);
    pane.advance(1600);
    expect(pane.activities()).toEqual(["idle"]);
  });
});

describe("ActivityDetector: lifecycle", () => {
  it("reports the fallback shell with the agent's exit code", () => {
    const pane = readyClaude();
    pane.title("");
    pane.title("C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    pane.detector.onAgentFallback(1);
    expect(pane.changes.at(-1)).toMatchObject({ activity: "agent_fallback", agentExitCode: 1 });
  });

  it("follows a Claude started by hand on the fallback shell, until it exits", () => {
    const pane = readyClaude();
    pane.detector.onAgentFallback(0);
    expect(pane.activity).toBe("agent_fallback");

    pane.input("claude\r");
    pane.title("claude");
    pane.frame(CLAUDE_IDLE);
    pane.title("✳ Claude Code");
    expect(pane.activity).toBe("idle");
    pane.title("◐ Claude Code");
    expect(pane.activity).toBe("working");
    // Its hooks are not ours: a Claude typed by hand has no --settings.
    pane.detector.onHookEvent(hook("PermissionRequest", { toolName: "Bash" }));
    pane.title("✳ Claude Code");
    pane.advance(300);
    expect(pane.activity).toBe("idle");

    pane.title("");
    pane.frame(["PS C:\\Users\\mathe> "], "PS C:\\Users\\mathe> ");
    pane.advance(300);
    expect(pane.activity).toBe("agent_fallback");
    expect(pane.changes.at(-1)?.agentExitCode).toBe(0);
  });

  it("ignores everything a dead process still prints", () => {
    const pane = readyClaude();
    pane.detector.onExit(0);
    expect(pane.activity).toBe("exited");
    pane.frame(CLAUDE_WORKING);
    pane.title("◐ Claude Code");
    pane.input("\r");
    pane.advance(10_000);
    expect(pane.activities()).toEqual(["idle", "exited"]);
  });

  it("reports a non-zero exit and a failed spawn as errors", () => {
    const crashed = readyShell();
    crashed.detector.onExit(1);
    expect(crashed.activity).toBe("error");

    const failed = setup("claude");
    failed.detector.onError();
    expect(failed.activity).toBe("error");
  });

  it("does not read the previous process's screen as the new one's after a restart", () => {
    // scratchpad/rev5/restart-sim.cjs: a restart reuses the pane's xterm, and
    // ConPTY's first chunk ("\x1b[?9001h\x1b[?1004h") comes ~700 ms before
    // the new process paints. The dead REPL's "? for shortcuts" read as
    // ready, so the trust dialog skipped its startup grace ("Aguardando").
    let lines = [...CLAUDE_IDLE, "", "── sessão reiniciada (tentativa 2) ──"];
    const xterm: ScreenSource = {
      get rows() {
        return lines.length;
      },
      buffer: {
        active: {
          type: "normal",
          baseY: 0,
          cursorX: 0,
          get cursorY() {
            return lines.length - 1;
          },
          getLine: (y: number) =>
            lines[y] === undefined
              ? undefined
              : { translateToString: (_trim?: boolean, start = 0, end?: number) => lines[y].slice(start, end) },
        },
      },
    };
    const spawnScreen = new SpawnScreenReader(xterm);
    const changes: PaneActivity[] = [];
    const detector = new ActivityDetector({
      agentProfileId: "claude",
      readScreen: spawnScreen.read,
      onChange: (activity) => changes.push(activity),
    });
    const frame = (text: string) => {
      spawnScreen.noteFrame(text);
      detector.onFrame();
    };
    detector.onStarting();
    spawnScreen.holdUntilPainted();
    detector.onRunning();
    frame("\x1b[?9001h\x1b[?1004h");
    vi.advanceTimersByTime(700);
    expect(changes).toEqual([]);

    // The new process paints its workspace trust dialog over a clear.
    lines = CLAUDE_TRUST;
    frame("\x1b[?25l\x1b[2J\x1b[m\x1b[H Quick safety check…");
    vi.advanceTimersByTime(1500);
    expect(changes).toEqual([]);
    // Answered in time by the auto-accept: never "Aguardando".
    lines = CLAUDE_IDLE;
    frame("\x1b[2J ? for shortcuts");
    detector.onTitle("✳ Claude Code");
    vi.advanceTimersByTime(2000);
    expect(changes).toEqual(["idle"]);
  });

  it("ignores titles that arrive before the spawn is confirmed", () => {
    const changes: PaneActivity[] = [];
    const detector = new ActivityDetector({
      agentProfileId: "claude",
      onChange: (activity) => changes.push(activity),
    });
    detector.onStarting();
    // Leftover from the previous process, still draining through xterm.
    detector.onTitle("◐ Old session");
    vi.advanceTimersByTime(10);
    detector.onRunning();
    vi.advanceTimersByTime(3000);
    expect(changes).toEqual([]);
  });

  it("ignores hook events on panes that are not Claude", () => {
    const pane = readyCodex();
    pane.detector.onHookEvent(hook("PermissionRequest", { toolName: "Bash" }));
    pane.advance(1000);
    expect(pane.activities()).toEqual(["idle"]);
  });

  it("stops scheduling once disposed", () => {
    const pane = setup("shell");
    pane.frame(["PS C:\\> "], "PS C:\\> ");
    pane.detector.dispose();
    pane.advance(10_000);
    expect(pane.changes).toEqual([]);
  });
});
