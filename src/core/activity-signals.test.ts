import { describe, expect, it } from "vitest";

import type { AgentHookEvent } from "../types/agent-hooks";
import {
  classifyHookEvent,
  classifyScreen,
  classifyTitle,
  classifyUserKey,
  formatToolDetail,
  isReplProfile,
  isReplPromptAtCursor,
  isShellPromptAtCursor,
  isShellTitle,
  isTerminalReply,
  profileFamily,
} from "./activity-signals";
import type { ScreenSnapshot } from "./terminal-screen";

// Every string below was captured from the real CLIs through ConPTY:
// Claude Code 2.1.283, codex-cli 0.155.1, cursor-agent 2026.09.23.

function screen(rows: string[], cursorLine = "", altScreen = false): ScreenSnapshot {
  return { rows, cursorLine, altScreen };
}

const RULE = "─".repeat(120);
const PWSH_TITLE =
  "C:\\Program Files\\WindowsApps\\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\\pwsh.exe";

describe("profileFamily", () => {
  it("knows the three agents and treats everything else as a shell", () => {
    expect(profileFamily("claude")).toBe("claude");
    expect(profileFamily("codex")).toBe("codex");
    expect(profileFamily("cursor")).toBe("cursor");
    for (const id of ["shell", "ollama", "ornith", "qwen27", "antigravity", "whatever"]) {
      expect(profileFamily(id)).toBe("shell");
    }
  });
});

describe("classifyTitle", () => {
  it("ignores titles the console sets on its own", () => {
    for (const title of [
      "",
      "claude",
      PWSH_TITLE,
      "C:\\WINDOWS\\system32\\cmd.exe",
      "Administrator: Windows PowerShell",
      "mathe@box: ~/dev/head-terminal",
      "~/dev/head-terminal",
    ]) {
      expect(classifyTitle(title), title).toBeNull();
      expect(classifyTitle(title, "codex"), title).toBeNull();
    }
    expect(isShellTitle(PWSH_TITLE)).toBe(true);
    expect(isShellTitle("✳ Claude Code")).toBe(false);
  });

  it("reads Claude's half-circle spinner as working and ✳ as not working", () => {
    expect(classifyTitle("◐ Claude Code")).toEqual({ family: "claude", state: "working" });
    expect(classifyTitle("◑ Reply with OK")).toEqual({ family: "claude", state: "working" });
    expect(classifyTitle("✳ Claude Code")).toEqual({ family: "claude", state: "idle" });
    expect(classifyTitle("✳ Sleep command test")).toEqual({ family: "claude", state: "idle" });
  });

  it("reads codex's default titles", () => {
    expect(classifyTitle("⠧ work-a")).toEqual({ family: "codex", state: "working" });
    expect(classifyTitle("⠋ Reply OK | work-a")).toEqual({ family: "codex", state: "working" });
    expect(classifyTitle("⠸ renaming... ⠸ | work-a")).toEqual({ family: "codex", state: "working" });
    expect(classifyTitle("[ ! ] Action Required | Reply OK | work-a")).toEqual({
      family: "codex",
      state: "blocked",
    });
    expect(classifyTitle("[ . ] Action Required | renaming... ⠧ | work-l")).toMatchObject({
      state: "blocked",
    });
  });

  it("reads codex's plain title as idle only once codex owns the title", () => {
    // Only a leading spinner means work: "renaming... ⠦" is the thread name
    // being generated after the turn already ended.
    expect(classifyTitle("renaming... ⠦ | work-a", "codex")).toEqual({ family: "codex", state: "idle" });
    expect(classifyTitle("Reply OK | work-a", "codex")).toEqual({ family: "codex", state: "idle" });
    expect(classifyTitle("work-a", "codex")).toEqual({ family: "codex", state: "idle" });
    expect(classifyTitle("work-a")).toBeNull();
    expect(classifyTitle("renaming... ⠦ | work-a")).toBeNull();
  });

  it("reads codex's run-state titles", () => {
    expect(classifyTitle("Ready")).toEqual({ family: "codex", state: "idle" });
    expect(classifyTitle("Starting ⠙")).toEqual({ family: "codex", state: "starting" });
    expect(classifyTitle("⠙ Starting")).toEqual({ family: "codex", state: "starting" });
    expect(classifyTitle("Working ⠋")).toEqual({ family: "codex", state: "working" });
    expect(classifyTitle("⠸ Working | codexcwd")).toEqual({ family: "codex", state: "working" });
    // "Waiting" is codex waiting on a background terminal: still work.
    expect(classifyTitle("Waiting ⠋")).toEqual({ family: "codex", state: "working" });
    expect(classifyTitle("[ ! ] Action Required")).toEqual({ family: "codex", state: "blocked" });
    expect(classifyTitle("Ready | 01a0db3d-c384-7620-ae71-465f5... ⠏")).toEqual({
      family: "codex",
      state: "idle",
    });
    expect(classifyTitle("Working ⠇ 01a0db3d-c384-7620-ae71-465f5... ⠇")).toEqual({
      family: "codex",
      state: "working",
    });
    expect(classifyTitle("Starting ⠙ 01a0db3d-c384-7620-ae71-465f5...")).toEqual({
      family: "codex",
      state: "starting",
    });
  });

  it("does not mistake an idle thread named after a state for that state", () => {
    expect(classifyTitle("Working on the parser | proj", "codex")).toEqual({
      family: "codex",
      state: "idle",
    });
  });

  it("reads cursor's status indicators", () => {
    expect(classifyTitle("Cursor Agent - ✅ Ready")).toEqual({ family: "cursor", state: "idle" });
    expect(classifyTitle("Just OK - ⏳ Working ···")).toEqual({ family: "cursor", state: "working" });
    expect(classifyTitle("Just OK - ⏳ Working ..·")).toEqual({ family: "cursor", state: "working" });
    expect(classifyTitle("Just OK - 🔐 Waiting for confirmation")).toEqual({
      family: "cursor",
      state: "blocked",
      reason: "approval",
    });
    expect(classifyTitle("Just OK - ❓ Waiting for you")).toEqual({
      family: "cursor",
      state: "blocked",
      reason: "question",
    });
    expect(classifyTitle("Just OK - 🔄 Reconnecting")).toEqual({ family: "cursor", state: "keep" });
    expect(classifyTitle("Chat - 📂 Loading conversation")).toEqual({
      family: "cursor",
      state: "starting",
    });
    expect(classifyTitle("Chat - ⌨️ Running shell command")).toEqual({
      family: "cursor",
      state: "working",
    });
    expect(classifyTitle("Chat - ✅ Ready (feat-x)")).toEqual({ family: "cursor", state: "idle" });
  });

  it("reads agent titles named after a file or a shell as the agent's", () => {
    // Claude names the session after the task; cursor names the chat.
    expect(classifyTitle("◐ Deploy mysite.com", "claude")).toEqual({ family: "claude", state: "working" });
    expect(classifyTitle("✳ Fix install.ps1", "claude")).toEqual({ family: "claude", state: "idle" });
    expect(classifyTitle("◑ Debug server.exe")).toEqual({ family: "claude", state: "working" });
    expect(classifyTitle("Bash deploy script - ⏳ Working ···", "cursor")).toEqual({
      family: "cursor",
      state: "working",
    });
    expect(classifyTitle("PowerShell profile fix - 🔐 Waiting for confirmation")).toEqual({
      family: "cursor",
      state: "blocked",
      reason: "approval",
    });
    expect(classifyTitle("[ ! ] Action Required | fix run.cmd")).toEqual({ family: "codex", state: "blocked" });
    expect(classifyTitle("⠋ build.bat", "codex")).toEqual({ family: "codex", state: "working" });
    // The shell taking the title back is still nothing.
    expect(classifyTitle("C:\\WINDOWS\\system32\\cmd.exe", "claude")).toBeNull();
    expect(classifyTitle("pwsh.exe", "codex")).toBeNull();
    expect(classifyTitle("bash", "cursor")).toBeNull();
  });

  it("reads cursor's plain title as up-but-silent once cursor owns the title", () => {
    expect(classifyTitle("Cursor Agent", "cursor")).toEqual({ family: "cursor", state: "ready" });
    expect(classifyTitle("Just OK", "cursor")).toEqual({ family: "cursor", state: "ready" });
    expect(classifyTitle("Cursor Agent")).toBeNull();
  });
});

describe("classifyScreen: Claude", () => {
  const permission = screen([
    "● Write(probe.txt)",
    "",
    RULE,
    " Create file",
    " probe.txt",
    "╌".repeat(120),
    "  1 hi",
    "╌".repeat(120),
    " Do you want to create probe.txt?",
    " ❯ 1. Yes",
    "   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend",
    "",
    "",
  ]);

  it("recognizes a permission dialog and the tool it is for", () => {
    expect(classifyScreen("claude", permission)).toEqual({
      state: "blocked",
      reason: "approval",
      detail: "Write",
    });
  });

  it("names the tool only when its call sits right above the dialog", () => {
    // runs/hooks2 at 12 s: Claude 2.1.283 draws no "● Bash(" row for a Bash
    // request — an older call still on screen is not the one asked about
    // (scratchpad/rev5/tooldetail.cjs).
    const bash = [
      "● Read(package.json)",
      "  ⎿  Read 42 lines",
      "",
      "  Sleeping for 12 seconds, then writing \"done\" to sleep-done.txt",
      "  ⎿  $ sleep 12 && echo done > sleep-done.txt",
      "",
      RULE,
      " Bash command",
      "",
      "   sleep 12 && echo done > sleep-done.txt",
      "   Sleep for 12 seconds, then write \"done\" to sleep-done.txt",
      "",
      " Do you want to proceed?",
      " ❯ 1. Yes",
      "   2. Yes, and always allow access to C:\\Users\\mathe\\work from this project",
      "   3. No",
      "",
      " Esc to cancel · Tab to amend",
    ];
    expect(classifyScreen("claude", screen(bash))).toEqual({ state: "blocked", reason: "approval" });

    // A call further up, above an answer, says nothing either.
    const afterAnswer = screen(["● Write(probe.txt)", "  ⎿  Wrote 1 line", "● Now the command:", ...bash.slice(6)]);
    expect(classifyScreen("claude", afterAnswer)).toEqual({ state: "blocked", reason: "approval" });

    // The call right above the rule, even wrapped in a narrow pane.
    const narrow = screen([
      "❯ create probe.txt",
      "",
      "● Write(C:\\Users\\m",
      "  athe\\probe.txt)",
      "",
      "─".repeat(18),
      " Create file",
      " Do you want to",
      " create probe.txt?",
      " ❯ 1. Yes",
      "   2. No",
      " Esc to cancel",
    ]);
    expect(classifyScreen("claude", narrow)).toEqual({ state: "blocked", reason: "approval", detail: "Write" });
  });

  it("recognizes the onboarding screens of a fresh profile as a dialog", () => {
    // sweep/caps/audit-claude*.jsonl: a new CLAUDE_CONFIG_DIR, no REPL yet.
    const theme = screen([
      " Let's get started.",
      "",
      " Choose the text style that looks best with your terminal",
      " To change this later, run /theme",
      "",
      "   1. Auto (match terminal)",
      " ❯ 2. Dark mode ✔",
      "   3. Light mode",
      "   4. Dark mode (colorblind-friendly)",
      "   5. Light mode (colorblind-friendly)",
      "   6. Dark mode (ANSI colors only)",
      "   7. Light mode (ANSI colors only)",
      "",
      "╌".repeat(120),
      "  1  function greet() {",
      "  2 -  console.log(\"Hello, World!\");",
      "  2 +  console.log(\"Hello, Claude!\");",
      "  3  }",
      "╌".repeat(120),
      "  Syntax theme: Monokai Extended (ctrl+t to disable)",
    ]);
    expect(classifyScreen("claude", theme)).toEqual({ state: "blocked", reason: "dialog" });
    const login = screen([
      "Welcome to Claude Code v2.1.283",
      " Claude Code can be used with your Claude subscription or billed based on API usage through your Console account.",
      "",
      " Select login method:",
      "",
      " ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise",
      "   2. Anthropic Console account · API usage billing",
      "   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI",
    ]);
    expect(classifyScreen("claude", login)).toEqual({ state: "blocked", reason: "dialog" });

    // In a narrow pane the preview wraps and pushes the options far up.
    const narrowTheme = screen([
      " Choose the text style",
      " that looks best with your",
      " terminal",
      " ❯ 2. Dark mode ✔",
      "   3. Light mode",
      "   4. Dark mode",
      "   (colorblind-friendly)",
      "   5. Light mode",
      "   (colorblind-friendly)",
      "   6. Dark mode (ANSI",
      "   colors only)",
      "   7. Light mode (ANSI",
      "   colors only)",
      "╌".repeat(28),
      "  1  function greet() {",
      "  2 -  console.log(\"Hello,",
      "  World!\");",
      "  2 +  console.log(\"Hello,",
      "  Claude!\");",
      "  3  }",
      "╌".repeat(28),
      "  Syntax theme: Monokai",
      "  Extended (ctrl+t to",
      "  disable)",
    ]);
    expect(classifyScreen("claude", narrowTheme)).toEqual({ state: "blocked", reason: "dialog" });

    // The same words in a live REPL's transcript are just words.
    const quoted = screen([
      "❯ what does \"Select login method\" mean?",
      "● It is the onboarding step: ❯ 1. Claude account…",
      RULE,
      "❯ ",
      RULE,
      "  ⏸ manual mode on · ? for shortcuts",
    ]);
    expect(classifyScreen("claude", quoted)).toEqual({ state: "idle" });
  });

  it("recognizes AskUserQuestion as a question", () => {
    const question = screen([
      "❯ Use the AskUserQuestion tool to ask me one multiple-choice question \"Pick a color\"",
      RULE,
      " ☐ Color ",
      "",
      "Pick a color",
      "",
      "❯ 1. Red",
      "     The color red",
      "  2. Blue",
      "     The color blue",
      "  3. Type something.",
      RULE,
      "  4. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ]);
    expect(classifyScreen("claude", question)).toEqual({ state: "blocked", reason: "question" });
  });

  it("recognizes the workspace trust dialog, whichever option is selected", () => {
    const trust = screen([
      " Claude Code'll be able to read, edit, and execute files here.",
      "",
      " Security guide",
      "",
      " ❯ No, exit",
      "   Yes, I trust this folder",
      "",
      " Enter to confirm · Esc to cancel",
      "",
      "",
    ]);
    expect(classifyScreen("claude", trust)).toEqual({ state: "blocked", reason: "dialog" });
  });

  it("reads a dialog footer that wrapped in a narrow pane", () => {
    const narrow = screen([" Do you want to proceed?", " ❯ 1. Yes", "   2. No", " Esc to", " cancel · Tab", " to amend"]);
    expect(classifyScreen("claude", narrow)).toMatchObject({ state: "blocked", reason: "approval" });
  });

  it("sees a finished turn as idle, not blocked", () => {
    const done = screen([
      "❯ Reply with just the word OK.",
      "",
      "● OK",
      "",
      "✻ Worked for 4s · done 22:05",
      "",
      RULE,
      "❯ ",
      RULE,
      "  ⏸ manual mode on · ? for shortcuts · ← for agents",
    ]);
    expect(classifyScreen("claude", done)).toEqual({ state: "idle" });
  });

  it("sees a declined permission and an interrupted turn as idle", () => {
    const declined = screen([
      "● Write(probe.txt)",
      "  ⎿  User rejected write to probe.txt",
      "      1 hi",
      "",
      "✻ Sautéed for 3s · done 22:05",
      RULE,
      "❯ ",
      RULE,
      "  ⏸ manual mode on · ? for shortcuts · ← for agents",
    ]);
    expect(classifyScreen("claude", declined).state).toBe("idle");
    const interrupted = screen([
      "  155",
      "  ⎿  Interrupted · What should Claude do instead?",
      "",
      RULE,
      "❯ ",
      RULE,
      "  ⏸ manual mode on · ? for shortcuts · ← for agents",
    ]);
    expect(classifyScreen("claude", interrupted).state).toBe("idle");
  });

  it("does not take a prompt typed as a numbered list for a dialog", () => {
    const typing = screen([RULE, "❯ 1. fix the bug", RULE, "  ⏸ manual mode on"]);
    expect(classifyScreen("claude", typing).state).toBe("idle");
  });

  // The real idle screen of runs/hooks at s4-quiet, with the transcript the
  // review wrote into it (scratchpad/rev/fp-claude.cjs).
  const REPL_BOX = [RULE, "❯ ", RULE, "  ⏸ manual mode on · ? for shortcuts · ← for agents"];

  it("does not read the trust dialog's words in the transcript as the dialog", () => {
    const quoting = screen([
      "❯ Reply with just the word OK.",
      "● OK",
      "✻ Worked for 4s · done 22:05",
      "● Na 2.1.283 o dialog mostra \"❯ No, exit\" pré-selecionado e \"Yes, I trust this folder\"",
      "  como segunda opção; o auto-accept precisa mandar ↓ antes do Enter.",
      "✻ Worked for 9s · done 22:07",
      ...REPL_BOX,
    ]);
    expect(classifyScreen("claude", quoting)).toEqual({ state: "idle" });
    // Even whole option rows and the footer text, quoted above the REPL.
    const rows = screen([" ❯ No, exit", "   Yes, I trust this folder", "", " Enter to confirm · Esc to cancel", ...REPL_BOX]);
    expect(classifyScreen("claude", rows)).toEqual({ state: "idle" });
  });

  it("recognizes the trust dialog word-wrapped in a narrow pane", () => {
    const narrow = screen([" Security guide", "", " ❯ No, exit", "   Yes, I trust this", "   folder", "", " Enter to confirm ·", " Esc to cancel"]);
    expect(classifyScreen("claude", narrow)).toEqual({ state: "blocked", reason: "dialog" });
    // Without its footer it is not the live dialog.
    expect(classifyScreen("claude", screen([" ❯ No, exit", "   Yes, I trust this folder"])).state).toBeNull();
  });

  it("does not read a numbered prompt echo above 'Would you like to proceed?' as the plan dialog", () => {
    const finished = screen([
      "❯ Reply with just the word OK.",
      "● OK",
      "❯ 1. Crie o endpoint /health  2. Escreva os testes",
      "● Vou criar src/health.ts e tests/health.test.ts.",
      "  Would you like to proceed?",
      "✻ Worked for 3s · done 22:06",
      ...REPL_BOX,
    ]);
    expect(classifyScreen("claude", finished)).toEqual({ state: "idle" });
    // The user typing "1. sim" under that question.
    const typing = screen([
      "● Duas opções: 1. Postgres  2. SQLite.",
      "  Would you like to proceed?",
      "✻ Worked for 2s · done 22:08",
      RULE,
      "❯ 1. sim",
      RULE,
      "  ⏸ manual mode on",
    ]);
    expect(classifyScreen("claude", typing)).toEqual({ state: "idle" });
  });

  it("recognizes the plan dialog by its options under the question", () => {
    const plan = screen([
      " Here is Claude's plan:",
      "  1. Add src/health.ts",
      "  2. Cover it in tests/health.test.ts",
      "",
      " Would you like to proceed?",
      "",
      " ❯ 1. Yes, and auto-accept edits",
      "   2. Yes, and manually approve edits",
      "   3. No, keep planning",
    ]);
    expect(classifyScreen("claude", plan)).toEqual({ state: "blocked", reason: "question", detail: "plano" });
    const narrow = screen([" Would you like to", " proceed?", "", " ❯ 1. Yes, and", "   auto-accept edits", "   2. No, keep", "   planning"]);
    expect(classifyScreen("claude", narrow)).toEqual({ state: "blocked", reason: "question", detail: "plano" });
  });

  it("does not read a question's options that straddle a rule as the input box", () => {
    const question = screen([
      "❯ Use the AskUserQuestion tool to ask me one multiple-choice question.",
      RULE,
      " ☐ Color ",
      "Pick a color",
      "❯ 1. Red",
      "  2. Blue",
      "  3. Type something.",
      RULE,
      "  4. Chat about this",
      "",
      "Enter to select · ↑/↓ to navigate · Esc to cancel",
    ]);
    expect(classifyScreen("claude", question)).toEqual({ state: "blocked", reason: "question" });
  });

  it("reads the working footer (only used when Claude sets no title)", () => {
    const working = screen([
      "✶ Wibbling… (3s · ↓ 181 tokens · thought for 1s)",
      "  ⎿  Tip: Run claude --continue or claude --resume to resume a conversation",
      RULE,
      "❯ ",
      RULE,
      "  ⏸ manual mode on · esc to interrupt · ← for agents",
    ]);
    expect(classifyScreen("claude", working)).toEqual({ state: "working" });
  });
});

describe("classifyScreen: codex", () => {
  it("recognizes the edit approval", () => {
    const edits = screen([
      "• Added probe.txt (+1 -0)",
      "    1 +hi",
      "",
      "",
      "  Would you like to make the following edits?",
      "",
      "  Description: Apply proposed file edits",
      "  Destination:",
      "  C:\\Users\\mathe\\AppData\\Local\\Temp\\work-a\\probe.txt",
      "",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for these files (a)",
      "  3. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel",
    ]);
    expect(classifyScreen("codex", edits)).toEqual({
      state: "blocked",
      reason: "approval",
      detail: "edição",
    });
  });

  it("recognizes the command approval", () => {
    const command = screen([
      "• Running New-Item -ItemType Directory probe_dir",
      "  Would you like to run the following command?",
      "  Environment: local",
      "  Reason: create the directory",
      "  $ New-Item -ItemType Directory probe_dir",
      "› 1. Yes, proceed (y)",
      "  2. Yes, and don't ask again for commands that start with `New-Item` (p)",
      "  3. No, and tell Codex what to do differently (esc)",
      "",
      "  Press enter to confirm or esc to cancel",
    ]);
    expect(classifyScreen("codex", command)).toEqual({
      state: "blocked",
      reason: "approval",
      detail: "comando",
    });
  });

  it("recognizes request_user_input as a question", () => {
    const question = screen([
      "  Question 1/1 (1 unanswered)",
      "  Which color do you prefer?",
      "",
      "  › 1. Red                Choose red.",
      "    2. Blue               Choose blue.",
      "    3. None of the above  Optionally, add details in notes (tab).",
      "",
      "  tab to add notes | enter to submit answer | esc to interrupt",
    ]);
    expect(classifyScreen("codex", question)).toEqual({ state: "blocked", reason: "question" });
  });

  it("recognizes the startup screens that never touch the title", () => {
    const update = screen([
      "  ✨ Update available! 0.155.1 -> 0.156.1",
      "",
      "  Release notes: https://github.com/openai/codex/releases/latest",
      "",
      "› 1. Update now (runs `powershell -ExecutionPolicy Bypass -c '$env:CODEX_NON_INTERACTIVE=1; irm",
      "     https://chatgpt.com/codex/install.ps1 | iex'`)",
      "  2. Skip",
      "  3. Skip until next version",
      "",
      "  Press enter to continue",
    ]);
    expect(classifyScreen("codex", update)).toEqual({ state: "blocked", reason: "dialog" });
    const trust = screen([
      "  Do you trust the contents of this directory?",
      "› 1. Yes, continue",
      "  2. No, quit",
      "",
      "  Press enter to continue",
    ]);
    expect(classifyScreen("codex", trust)).toEqual({ state: "blocked", reason: "dialog" });
  });

  it("recognizes the trust screen with its footer truncated in a narrow pane", () => {
    // sweep/live/codex-start-<cols>x40: codex cuts the footer, it does not
    // wrap it.
    for (const footer of ["  Press enter to continu", "  Press enter to conti", "  Press enter to c"]) {
      const trust = screen([
        "  the directory allows",
        "  project-local config,",
        "  hooks, and exec",
        "  policies to load.",
        "",
        "› 1. Yes, continue",
        "  2. No, quit",
        "",
        footer,
      ]);
      expect(classifyScreen("codex", trust), footer).toEqual({ state: "blocked", reason: "dialog" });
    }
  });

  it("does not read an answered question or the composer as blocked", () => {
    const answered = screen([
      "• Questions 1/1 answered",
      "  • Which color do you prefer?",
      "    answer: Red",
      "",
      "  done 9:56 PM",
      "",
      "› Ask Codex to do anything",
      "",
      "  gpt-5.6-luna low · ~\\AppData\\Local\\Temp\\work-b",
    ]);
    expect(classifyScreen("codex", answered)).toEqual({ state: "idle" });
  });

  it("reads the working row", () => {
    const working = screen([
      "› Reply with just the word OK.",
      "",
      "• Working (0s • esc to interrupt)",
      "",
      "› Ask Codex to do anything",
    ]);
    expect(classifyScreen("codex", working)).toEqual({ state: "working" });
  });

  it("does not read a prompt echo that mentions a 'Question N/M' as a question", () => {
    // scratchpad/rev/fp-codex-cursor.cjs codex, on the real cap-a idle screen.
    const echo = screen([
      "› Reply with just the word OK.",
      "• OK",
      "› Explain Question 2/5 of the worksheet",
      "",
      "› Ask Codex to do anything",
      "",
      "  gpt-5.6-luna low · ~\\AppData\\Local\\Temp\\work-a",
    ]);
    expect(classifyScreen("codex", echo)).toEqual({ state: "idle" });
  });
});

describe("classifyScreen: cursor", () => {
  const trustBox = [
    "  │  ⚠ Workspace Trust Required                                                       │",
    "  │  Cursor Agent can execute code and access files in this directory.                │",
    "  │  Do you trust the contents of this directory?                                     │",
    "  │    C:\\Users\\mathe\\ws-a                                                            │",
  ];

  it("recognizes the workspace trust dialog while it asks", () => {
    const asking = screen([
      ...trustBox,
      "  │  ▶ [a] Trust this workspace                                                       │",
      "  │    [q] Quit                                                                       │",
      "  │  Use arrow keys to navigate, Enter to select, or press the key shown              │",
      "  ╰───────────────────────────────────────────────────────────────────────────────────╯",
    ]);
    expect(classifyScreen("cursor", asking)).toEqual({ state: "blocked", reason: "dialog" });
  });

  it("recognizes the trust dialog boxed and word-wrapped in a narrow pane", () => {
    // sweep/live/cursor-trust-32x40 and -18x40, as rendered: the option wraps
    // inside the box, at 18 columns in the middle of a word.
    const at32 = [
      "  │  Do you trust the        │",
      "  │  contents of this        │",
      "  │  directory?              │",
      "  │                          │",
      "  │    C:\\Users\\mathe\\AppDa  │",
      "  │    ta\\Local\\Temp\\ws-a    │",
      "  │                          │",
      "  │  ▶ [a] Trust this        │",
      "  │  workspace               │",
      "  │    [q] Quit              │",
      "  │                          │",
      "  │  Use arrow keys to       │",
      "  │  navigate, Enter to      │",
      "  │  select, or press the    │",
      "  │  key shown               │",
      "  │                          │",
      "  ╰──────────────────────────╯",
    ];
    expect(classifyScreen("cursor", screen(at32))).toEqual({ state: "blocked", reason: "dialog" });
    const at18 = [
      "  │    ws-a    │  ",
      "  │            │  ",
      "  │            │  ",
      "  │  ▶ [a]     │  ",
      "  │  Trust     │  ",
      "  │  this wor  │  ",
      "  │  kspace    │  ",
      "  │    [q]     │  ",
      "  │  Quit      │  ",
      "  │            │  ",
      "  │  Use       │  ",
      "  │  arrow     │  ",
      "  │  keys to   │  ",
      "  │  navigate  │  ",
      "  │  , Enter   │  ",
      "  │  to        │  ",
      "  │  select,   │  ",
      "  │  or press  │  ",
      "  │  the key   │  ",
      "  │  shown     │  ",
      "  │            │  ",
      "  ╰────────────╯  ",
    ];
    expect(classifyScreen("cursor", screen(at18))).toEqual({ state: "blocked", reason: "dialog" });

    // Answered: the ▶ is gone, the box is history.
    const answered = screen(at32.map((row) => row.replace("▶", " ")));
    expect(classifyScreen("cursor", answered).state).not.toBe("blocked");
  });

  it("reads the trusting pause as starting and the leftover box as history", () => {
    const trusting = [
      ...trustBox,
      "  │    [a] Trust this workspace                                                       │",
      "  │    [q] Quit                                                                       │",
      "  │  ⏳ Trusting workspace...                                                         │",
      "  ╰───────────────────────────────────────────────────────────────────────────────────╯",
    ];
    expect(classifyScreen("cursor", screen(trusting))).toEqual({ state: "starting" });
    const up = screen([
      ...trusting,
      "  Cursor Agent",
      "  v2026.09.23-86fc751",
      "  → Plan, search, build anything",
      "  Grok 4.7 500K Extra High Fast · MAX                                   Run Everything",
    ]);
    expect(classifyScreen("cursor", up)).toEqual({ state: "idle" });
  });

  it("reads the spinner row as working", () => {
    const working = screen([
      "  Reply with just the word OK.",
      "  OK",
      " ⠠⠜ Working  16 tokens",
      "    Tip: Use subagents to parallelize work and preserve context.",
      "  → Add a follow-up                                                     ctrl+c to stop",
    ]);
    expect(classifyScreen("cursor", working)).toEqual({ state: "working" });
    expect(classifyScreen("cursor", screen(["⠀⠞ Thinking 5 tokens"]))).toEqual({ state: "working" });
  });

  it("recognizes the shell approval and the correction prompt after Esc", () => {
    const approval = screen([
      "  $ echo hi > probe.txt Waiting for approval...",
      "─".repeat(120),
      " $  echo hi > probe.txt in .",
      " Run this command?",
      " Not in allowlist: echo",
      "  → Run (once) (y)",
      "    Add Shell(echo) to allowlist? (tab)",
      "    Run Everything (shift+tab)",
      "    Skip & tell the agent what to do instead (esc or n)",
    ]);
    expect(classifyScreen("cursor", approval)).toEqual({ state: "blocked", reason: "approval" });
    const correction = screen([
      "  → Tell the agent what to do instead (Enter to send, empty to skip, Esc to cancel)   ctrl+c to stop",
    ]);
    expect(classifyScreen("cursor", correction)).toEqual({ state: "blocked", reason: "approval" });
  });

  it("recognizes AskQuestion", () => {
    const question = screen([
      " │ Preference                                                   │",
      " │ Question 1 of 1                                              │",
      " │ 1. Do you prefer option A or option B?                       │",
      " │   › [ ] Option A                                             │",
      " │     [ ] Option B                                             │",
      " │ ↑/↓ option · ←/→ question · Space select · Enter next/submit · Esc to skip │",
    ]);
    expect(classifyScreen("cursor", question)).toEqual({ state: "blocked", reason: "question" });
  });

  it("sees a finished turn as idle", () => {
    const done = screen([
      "  Created probe.txt with hi and ran the command. Output: done.",
      "",
      "  → Add a follow-up",
      "  Grok 4.7 500K Extra High Fast · MAX · 3.5% · 1 file edited          Run Everything",
    ]);
    expect(classifyScreen("cursor", done)).toEqual({ state: "idle" });
  });

  it("recognizes the correction prompt inside its input box, status rows under it", () => {
    // cursor-cap/runB at 230 s, and with the status rows of a later frame.
    const correction = [
      "  $ echo hi > probe.txt Waiting for approval...",
      " ┌──────────────────────────────┐",
      " │ $  echo hi > probe.txt in .  │",
      " └──────────────────────────────┘",
      " ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄",
      "  → Tell the agent what to do instead (Enter to send, empty to skip, Esc to cancel)   ctrl+c to stop",
      " ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀",
    ];
    expect(classifyScreen("cursor", screen(correction))).toEqual({ state: "blocked", reason: "approval" });
    expect(
      classifyScreen("cursor", screen([...correction, "  1 task", "  Grok 4.7 500K · MAX · 3%", "  ~\\proj"])),
    ).toEqual({ state: "blocked", reason: "approval" });
    // runB at 276.9 s: the user typing the correction over the placeholder.
    const typing = [...correction];
    typing[5] = "  → Do not run anything. Just reply STOPPED.";
    expect(classifyScreen("cursor", screen(typing))).toEqual({ state: "blocked", reason: "approval" });
    // Without the pending tool and its command box above, typed text is a
    // follow-up at an idle prompt.
    expect(classifyScreen("cursor", screen(["  OK", ...typing.slice(4)]))).toEqual({ state: "idle" });
  });

  it("does not read the approval's phrases in the transcript as the dialog", () => {
    // scratchpad/rev/fp-codex-cursor.cjs cursor, on the real runA idle screen.
    const echoes = screen([
      "  Why does my script print \"Waiting for approval...\" forever?",
      "  It asks \"Run this command?\" and I pick Skip & tell the agent what to do instead.",
      "  Question 2 of 5 is still open, and so is the part where you tell the agent what to do instead.",
      "",
      "  → Add a follow-up",
      "  Grok 4.7 500K Extra High Fast · MAX · 3.4%",
    ]);
    expect(classifyScreen("cursor", echoes)).toEqual({ state: "idle" });
  });

  it("does not take the Reconnecting spinner after a turn for work", () => {
    // cursor-cap/runB without status indicators, 99 s and 112 s.
    const reconnecting = screen([
      "  OK",
      " ⠘⠆ Reconnecting (attempt 1, 1s)",
      "  → Add a follow-up",
      "  Grok 4.7 500K Extra High Fast · MAX · 3.4%",
    ]);
    expect(classifyScreen("cursor", reconnecting)).toEqual({ state: "idle" });
    // A reconnect in mid-turn still shows "ctrl+c to stop".
    const midTurn = screen([" ⠠⠛ Reconnecting to agentn…", "  → Add a follow-up        ctrl+c to stop"]);
    expect(classifyScreen("cursor", midTurn)).toEqual({ state: "working" });
  });
});

describe("classifyScreen: shells", () => {
  it("has nothing to say about a shell's screen", () => {
    expect(classifyScreen("shell", screen(["Press enter to continue", "❯ 1. Yes", "Esc to cancel"]))).toEqual({
      state: null,
    });
  });
});

describe("isShellPromptAtCursor", () => {
  it("recognizes common prompts at the cursor", () => {
    for (const line of [
      "PS C:\\Users\\mathe> ",
      "PS C:\\Users\\mathe>",
      "\\codex\\work-a> ",
      "mathe@box:~/dev$ ",
      "root@box:/# ",
      "box% ",
      "❯ ",
      ">>> ",
      "> ",
      "λ ",
    ]) {
      expect(isShellPromptAtCursor(screen([], line)), line).toBe(true);
    }
  });

  it("does not see a prompt with a command typed after it, or nothing at all", () => {
    expect(isShellPromptAtCursor(screen([], "PS C:\\Users\\mathe> git sta"))).toBe(false);
    expect(isShellPromptAtCursor(screen([], ""))).toBe(false);
    expect(isShellPromptAtCursor(screen([], "Compiling head-terminal"))).toBe(false);
  });

  it("recognizes an unusual prompt by the symbol it started with", () => {
    const learned = "➜  head-terminal git:(main) ✗ ";
    expect(isShellPromptAtCursor(screen([], "➜  tmp "), learned)).toBe(true);
    expect(isShellPromptAtCursor(screen([], "➜  tmp "))).toBe(false);
    // A prompt that starts with a letter teaches nothing: output does too.
    expect(isShellPromptAtCursor(screen([], "mathe ready "), "mathe box ")).toBe(false);
  });

  it("never sees a prompt inside a full-screen program", () => {
    expect(isShellPromptAtCursor(screen([], "PS C:\\> ", true))).toBe(false);
  });
});

describe("isReplPromptAtCursor", () => {
  it("knows which profiles run a local model's REPL", () => {
    expect(["ollama", "ornith", "qwen27"].every(isReplProfile)).toBe(true);
    expect(["shell", "claude", "antigravity"].some(isReplProfile)).toBe(false);
  });

  it("sees only the REPL's own prompt as the whole cursor line", () => {
    expect(isReplPromptAtCursor(screen([], ">>> "))).toBe(true);
    expect(isReplPromptAtCursor(screen([], "> "))).toBe(true);
    expect(isReplPromptAtCursor(screen([], ">"))).toBe(true);
    // What a model streams and pauses on (scratchpad/rev/shell-cases.cjs).
    for (const line of ["const add = (a, b) =>", "<div>", "Loading 50%", "## ", "C# ", "$ ", ">>> hello"]) {
      expect(isReplPromptAtCursor(screen([], line)), line).toBe(false);
    }
    expect(isReplPromptAtCursor(screen([], ">>> ", true))).toBe(false);
  });
});

describe("classifyHookEvent", () => {
  const hook = (event: string, extra: Partial<AgentHookEvent> = {}): AgentHookEvent => ({
    paneId: "p",
    source: "claude",
    event,
    receivedAt: 0,
    ...extra,
  });

  it("blocks on a permission request, naming the tool", () => {
    expect(classifyHookEvent(hook("PermissionRequest", { toolName: "Bash" }))).toEqual({
      kind: "blocked",
      block: { reason: "approval", detail: "Bash" },
    });
    expect(classifyHookEvent(hook("PermissionRequest", { toolName: "AskUserQuestion" }))).toEqual({
      kind: "blocked",
      block: { reason: "question", detail: undefined },
    });
    expect(classifyHookEvent(hook("PermissionRequest", { toolName: "ExitPlanMode" }))).toEqual({
      kind: "blocked",
      block: { reason: "question", detail: "plano" },
    });
  });

  it("never reads idle_prompt as waiting", () => {
    expect(classifyHookEvent(hook("Notification", { notificationType: "idle_prompt" }))).toEqual({
      kind: "ignore",
    });
  });

  it("maps the notifications that do mean a dialog", () => {
    expect(classifyHookEvent(hook("Notification", { notificationType: "permission_prompt" }))).toEqual({
      kind: "blocked",
      block: { reason: "approval" },
      weak: true,
    });
    for (const type of ["elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]) {
      expect(classifyHookEvent(hook("Notification", { notificationType: type }))).toEqual({
        kind: "blocked",
        block: { reason: "question" },
      });
    }
    expect(classifyHookEvent(hook("Notification", { notificationType: "auth_success" }))).toEqual({
      kind: "ignore",
    });
    expect(classifyHookEvent(hook("Elicitation"))).toEqual({
      kind: "blocked",
      block: { reason: "question" },
    });
  });

  it("resumes on work and stops on the end of a turn", () => {
    for (const event of [
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PostToolBatch",
      "ElicitationResult",
    ]) {
      expect(classifyHookEvent(hook(event)), event).toEqual({ kind: "resume" });
    }
    expect(classifyHookEvent(hook("Stop"))).toEqual({ kind: "stop" });
    expect(classifyHookEvent(hook("StopFailure", { error: "rate_limit" }))).toEqual({ kind: "stop" });
  });

  it("ignores the internal subagent stop and the session end", () => {
    expect(classifyHookEvent(hook("SubagentStop", { agentType: "" }))).toEqual({ kind: "ignore" });
    expect(classifyHookEvent(hook("SessionEnd"))).toEqual({ kind: "ignore" });
  });

  it("formats tool details for people", () => {
    expect(formatToolDetail("Write")).toBe("Write");
    expect(formatToolDetail("mcp__github__create_issue")).toBe("github · create_issue");
    expect(formatToolDetail(undefined)).toBeUndefined();
  });
});

describe("user input", () => {
  it("tells terminal replies from keys", () => {
    expect(isTerminalReply("\x1b[12;1R")).toBe(true);
    expect(isTerminalReply("\x1b[?1;2c")).toBe(true);
    expect(isTerminalReply("\x1b]11;rgb:0000/0000/0000\x1b\\")).toBe(true);
    expect(isTerminalReply("\x1b[I")).toBe(true);
    expect(isTerminalReply("a")).toBe(false);
    expect(isTerminalReply("\r")).toBe(false);
    expect(isTerminalReply("\x1b[A")).toBe(false);
  });

  it("classifies the keys that can answer a dialog", () => {
    expect(classifyUserKey("\x1b")).toBe("escape");
    expect(classifyUserKey("\r")).toBe("enter");
    // Enter typed after a paste submits it; a \r inside the paste brackets
    // only fills the line editor. An unbracketed paste does run.
    expect(classifyUserKey("\x1b[200~ls\x1b[201~\r")).toBe("enter");
    expect(classifyUserKey("\x1b[200~ls\r\x1b[201~")).toBe("other");
    expect(classifyUserKey("\x1b[200~git status\rgit log -1\x1b[201~")).toBe("other");
    expect(classifyUserKey("a\rb")).toBe("enter");
    expect(classifyUserKey("\x03")).toBe("interrupt");
    expect(classifyUserKey("1")).toBe("digit");
    expect(classifyUserKey("a")).toBe("other");
    expect(classifyUserKey("\x1b[B")).toBe("other");
    expect(classifyUserKey("\x1b[<64;40;10M")).toBe("other");
  });
});
