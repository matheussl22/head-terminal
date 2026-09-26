import type { PaneActivity, PaneBlock } from "../types/activity";
import type { AgentHookEvent } from "../types/agent-hooks";
import {
  classifyHookEvent,
  classifyScreen,
  classifyTitle,
  classifyUserKey,
  isReplProfile,
  isReplPromptAtCursor,
  isShellPromptAtCursor,
  isShellTitle,
  isTerminalReply,
  profileFamily,
  promptSigil,
  type AgentFamily,
  type ScreenSignal,
  type SignalFamily,
  type TitleSignal,
} from "./activity-signals";
import { EMPTY_SCREEN, type ScreenSnapshot } from "./terminal-screen";

/** Screen reads are coalesced: at most one per interval, always one after
 * the last frame. */
const EVAL_THROTTLE_MS = 100;
/** A shell prompt only counts once output stopped for this long — a ">" in
 * the middle of a stream is not a prompt. */
const PROMPT_QUIET_MS = 250;
/** A turn ending, and a dialog being answered, each repaint in steps: the
 * title flips a few ms before the dialog is drawn, codex flashes one spinner
 * frame after a decline. The new state has to hold this long before it is
 * shown, so a pane never blinks "Pronto" on its way to "Aguardando". */
const WORKING_TO_IDLE_SETTLE_MS = 200;
const BLOCKED_TO_WORKING_SETTLE_MS = 150;
/** A local model streaming slowly pauses between tokens on a lone ">" (a
 * markdown quote) or ">>>" (a Python example), which reads exactly like its
 * prompt: its turn only ends once the prompt held still this long. */
const REPL_WORKING_TO_IDLE_SETTLE_MS = 1500;
/** A shell prompt learned at a quiet moment may have been a question the rc
 * asked ("[oh-my-zsh] Would you like to update? [Y/n] "). After an Enter,
 * a different prompt-looking line that holds this long replaces it. */
const PROMPT_RELEARN_QUIET_MS = 1000;
/** PowerShell "PS C:\x> ", with whatever is typed after it. */
const POWERSHELL_PROMPT_LEAD = /^PS [^>]*> /u;
/** A learned prompt shorter than this ("$ ", "> ") is too common in output
 * to recognize a prompt by its start. */
const PROMPT_LEAD_MIN_CHARS = 3;
/** How long a reason-less "Action Required" title waits for its dialog. */
const TENTATIVE_BLOCK_SETTLE_MS = 150;
/** Codex paints its idle title a moment before booting its MCP servers
 * behind a spinner: "Pronto" only once the agent stayed ready this long. */
const AGENT_READY_SETTLE_MS = 1500;
/** A dialog on screen before the agent said it is up (title, prompt, idle
 * screen) is shown only after this long: Claude's workspace trust is
 * auto-answered in a few hundred ms and must not flash "Aguardando" (or
 * notify) on every spawn — not even when the quiet safety net already let
 * the pane out of "Iniciando" before the dialog was drawn. */
const STARTUP_BLOCK_GRACE_MS = 2000;
/** After a key that can answer a dialog, when to look again: declining a
 * Claude permission or interrupting with Esc fires no hook at all. */
const DIALOG_ANSWER_RECHECK_MS = 1200;
/** A dialog the screen recognized, then lost, for this long is gone. */
const HOOK_DIALOG_GONE_MS = 300;
/** Safety net for anything that never says it is ready: once output has
 * been quiet this long (or at the latest STARTING_MAX_MS after the first
 * byte) the pane is up. Agents get longer — their title is coming. */
const SHELL_STARTING_QUIET_MS = 2000;
const AGENT_STARTING_QUIET_MS = 5000;
const STARTING_MAX_MS = 20000;

type Lifecycle = "spawning" | "running" | "fallback" | "exited" | "error";

export interface ActivityChangeMeta {
  /** What produced the change: title, screen, hook, input, lifecycle… */
  source: string;
  /** agent_fallback only: the exit code the agent left with. */
  agentExitCode?: number;
}

export interface ActivityDetectorOptions {
  agentProfileId: string;
  onChange: (activity: PaneActivity, blocked: PaneBlock | undefined, meta: ActivityChangeMeta) => void;
  /** The pane's rendered screen (see terminal-screen.ts). */
  readScreen?: () => ScreenSnapshot;
}

interface Resolved {
  activity: PaneActivity;
  blocked?: PaneBlock;
  /** Blocked on nothing but a reason-less title ("Action Required"): the
   * dialog that says what it is may still be on its way to the screen. */
  tentative?: boolean;
}

function sameBlock(a: PaneBlock | undefined, b: PaneBlock | undefined): boolean {
  return a?.reason === b?.reason && a?.detail === b?.detail;
}

/**
 * The status of one pane spawn, backed only by signals that mean what they
 * say (see activity-signals.ts):
 * - the terminal title the agent sets for itself (Claude ◐/✳, codex spinner
 *   and "Action Required", cursor status indicators);
 * - the rendered screen: dialogs, spinners, prompts;
 * - Claude Code's own lifecycle hooks;
 * - the keys the user sends (Enter starts a shell command, Esc may answer a
 *   dialog);
 * - the pty lifecycle.
 *
 * "working" means the agent (or a shell's foreground command) is actually
 * processing. "waiting_input" only ever means blocked on the user — an agent
 * that finished its turn is "idle". Output volume and silence decide nothing:
 * every agent is silent both at its prompt and on an open dialog, and repaints
 * on every keystroke, mouse event and resize.
 */
export class ActivityDetector {
  private readonly profile: SignalFamily;
  private readonly onChange: ActivityDetectorOptions["onChange"];
  private readonly readScreenSource: () => ScreenSnapshot;

  private lifecycle: Lifecycle = "spawning";
  private agentExitCode: number | undefined;
  private current: PaneActivity = "starting";
  private currentBlock: PaneBlock | undefined;
  private pending: { activity: PaneActivity; since: number; source: string } | null = null;
  private disposed = false;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** The pane is out of "starting": the agent said so, or the safety net
   * gave up waiting. */
  private ready = false;
  /** The agent itself said it is up: a status title, its prompt or idle
   * screen, or a dialog that outlived the startup grace. The safety net
   * does not count — until then a dialog still gets its startup grace. */
  private readyBySignal = false;
  private firstOutputAt: number | null = null;
  private lastOutputAt = 0;
  private startupBlockSince: number | null = null;

  /** Last status title of the agent that owns the title, if any. */
  private title: TitleSignal | null = null;
  /** Which agent currently speaks through the title. Lets a shell pane — or
   * an agent pane fallen back to its shell — follow an agent started by hand
   * for as long as it keeps its title. */
  private titleFamily: AgentFamily | null = null;
  /** Families that ever sent a real status title: their title is then the
   * authority on "working" and the screen/hook guesses step aside. */
  private statusTitleFamilies = new Set<AgentFamily>();
  /** A prompt was submitted since this agent came up (codex spins its title
   * while booting MCP servers, before anyone asked it anything). */
  private promptSubmitted = false;

  private hookBlock: (PaneBlock & { weak?: boolean }) | null = null;
  private hookDialogSeen = false;
  private hookDialogGoneSince: number | null = null;
  private hookWorking = false;

  private shellWorking = false;
  private shellEnterAt = 0;
  private learnedPrompt: string | undefined;
  /** The learned prompt came back after an Enter: it is the shell's, and
   * stays. Until then it is only a guess (see relearnsPrompt). */
  private promptConfirmed = false;
  /** Something was typed at the shell since the last Enter — before its echo
   * arrives, the cursor still sits right after a bare prompt. */
  private typedSinceEnter = false;
  /** ollama / llama.cpp: their prompt, not a shell's, ends a turn. */
  private readonly repl: boolean;
  /** When a REPL's prompt last ended a turn (see resolveShell). */
  private replPromptAt: number | null = null;
  /** Anything the user sent, typing included: the echo explains output. */
  private lastUserInputAt = 0;

  constructor(options: ActivityDetectorOptions) {
    this.profile = profileFamily(options.agentProfileId);
    this.repl = isReplProfile(options.agentProfileId);
    this.onChange = options.onChange;
    this.readScreenSource = options.readScreen ?? (() => EMPTY_SCREEN);
  }

  get activity(): PaneActivity {
    return this.current;
  }

  get blocked(): PaneBlock | undefined {
    return this.currentBlock;
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /** A new process is about to spawn in this pane. */
  onStarting(): void {
    this.lifecycle = "spawning";
    this.clearTimers();
    this.pending = null;
    this.current = "starting";
    this.currentBlock = undefined;
  }

  /** The pty is up. The agent still has to show it is ready. */
  onRunning(): void {
    if (this.lifecycle !== "spawning") {
      return;
    }
    this.lifecycle = "running";
    this.evaluate("lifecycle");
  }

  /** xterm parsed a frame of pty output. */
  onFrame(): void {
    if (!this.isLive()) {
      return;
    }
    const now = Date.now();
    this.lastOutputAt = now;
    this.firstOutputAt ??= now;
    this.schedule("screen", EVAL_THROTTLE_MS, true);
    if (!this.ready) {
      this.schedule("safety", this.startingQuietMs() + 5);
      this.schedule("safety-cap", Math.max(0, this.firstOutputAt + STARTING_MAX_MS - now), true);
    }
    // A shell whose prompt is not learned yet is looked at once it went
    // quiet too: that is when its prompt is at the cursor.
    if (this.shellWorking || !this.ready || this.learnsPrompt()) {
      this.schedule("quiet", PROMPT_QUIET_MS + 5);
    }
    if (this.shellWorking && this.relearnsPrompt()) {
      this.schedule("relearn", PROMPT_RELEARN_QUIET_MS + 5);
    }
  }

  /** xterm's onTitleChange (OSC 0/2). */
  onTitle(rawTitle: string): void {
    // Before the spawn is confirmed, a title can only be a leftover of the
    // previous process still draining through xterm.
    if (!this.isLive() || this.lifecycle === "spawning") {
      return;
    }
    const agentPane = this.profile !== "shell" && this.lifecycle !== "fallback";
    const owner = agentPane ? this.profile : (this.titleFamily ?? undefined);
    const signal = classifyTitle(rawTitle, owner);

    if (!signal) {
      const text = rawTitle.trim();
      // The agent let go of the title: it exited (titles go "" and then back
      // to the shell's path), or it never had it.
      if ((!text || isShellTitle(text)) && (this.title || this.titleFamily)) {
        this.title = null;
        this.setTitleFamily(null);
        this.schedule("title", 0, true);
      }
      return;
    }
    if (signal.state === "keep") {
      return;
    }
    if (agentPane && signal.family !== this.profile) {
      return;
    }
    this.title = signal;
    this.setTitleFamily(signal.family);
    if (signal.state !== "ready") {
      this.statusTitleFamilies.add(signal.family);
    }
    // xterm reports the title mid-parse; the dialog codex and Claude draw in
    // the same frame is only on screen once the rest of the chunk is parsed.
    this.schedule("title", 0, true);
  }

  /** A Claude Code lifecycle hook for this pane. */
  onHookEvent(event: AgentHookEvent): void {
    // Only the agent the app launched carries the hooks; one started by
    // hand on the fallback shell does not.
    if (this.profile !== "claude" || this.lifecycle !== "running") {
      return;
    }
    const signal = classifyHookEvent(event);
    switch (signal.kind) {
      case "blocked":
        // "permission_prompt" only repeats that a dialog is open: it must not
        // blur the tool a PermissionRequest named, nor reopen a dialog the
        // user answered a moment ago.
        if (signal.weak && (this.hookBlock || this.timers.has("recheck"))) {
          return;
        }
        this.hookBlock = signal.weak ? { ...signal.block, weak: true } : signal.block;
        this.hookDialogSeen = false;
        this.hookDialogGoneSince = null;
        break;
      case "resume":
        this.hookBlock = null;
        this.hookWorking = true;
        break;
      case "stop":
        this.hookBlock = null;
        this.hookWorking = false;
        break;
      case "ignore":
        return;
    }
    this.evaluate("hook");
  }

  /** Everything the app writes to this pane's pty on the user's behalf:
   * keys, paste, voice, toolbar commands. */
  onUserInput(data: string): void {
    if (!this.isLive() || this.lifecycle === "spawning" || isTerminalReply(data)) {
      return;
    }
    this.lastUserInputAt = Date.now();
    const key = classifyUserKey(data);
    if (key === "other" || key === "digit") {
      // Typing, arrows (history), paste: the line is no longer bare, even
      // before its echo arrives.
      this.typedSinceEnter = true;
    } else if (key === "interrupt") {
      // Ctrl+C at a shell prompt drops the line.
      this.typedSinceEnter = false;
    }
    if (key === "other") {
      // Typing, arrows, mouse: none of it changes what the agent is doing.
      return;
    }

    if (key === "enter") {
      if (this.current !== "waiting_input") {
        this.promptSubmitted = true;
      }
      if (this.family() === "shell") {
        const snapshot = this.readScreen();
        // The shell is at its prompt, whatever was typed after it: a prompt
        // the pattern does not know is learned by its leading symbol. The
        // shell may have come up too slowly to learn it at readiness.
        if (!snapshot.altScreen && !this.shellWorking && this.learnsPrompt() && snapshot.cursorLine.trim()) {
          this.learnedPrompt = snapshot.cursorLine;
        }
        // Enter on a bare prompt runs nothing. Only nothing typed since the
        // last Enter makes it bare: an Enter right behind the typing reaches
        // the pty before the echo does, over a prompt that still looks empty.
        const emptySubmit = data === "\r" && !this.typedSinceEnter && this.promptAtCursor(snapshot);
        if (!snapshot.altScreen && !emptySubmit) {
          this.shellWorking = true;
          this.shellEnterAt = Date.now();
          this.schedule("quiet", PROMPT_QUIET_MS + 5);
        }
      }
      // Whatever an unbracketed paste left after its last line break is
      // sitting typed on the next prompt.
      this.typedSinceEnter = data.slice(data.lastIndexOf("\r") + 1).length > 0;
    }

    // Esc or Ctrl+C in mid-turn interrupts Claude without a Stop hook: look
    // again once it had time to repaint, as after answering a dialog.
    const interrupting = (key === "escape" || key === "interrupt") && this.hookWorking;
    if (this.current === "waiting_input" || this.hookBlock || interrupting) {
      this.schedule("recheck", DIALOG_ANSWER_RECHECK_MS);
    }
    this.evaluate("input");
  }

  /** The agent died and the pane fell back to its shell (OSC 7770). */
  onAgentFallback(exitCode: number): void {
    if (this.lifecycle === "exited" || this.lifecycle === "error") {
      return;
    }
    this.lifecycle = "fallback";
    this.agentExitCode = exitCode;
    this.title = null;
    this.setTitleFamily(null);
    this.hookBlock = null;
    this.hookWorking = false;
    this.ready = true;
    this.readyBySignal = true;
    this.replPromptAt = null;
    this.evaluate("lifecycle");
  }

  onExit(exitCode: number): void {
    this.finish(exitCode === 0 ? "exited" : "error");
  }

  onError(): void {
    this.finish("error");
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimers();
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private finish(lifecycle: "exited" | "error"): void {
    if (this.lifecycle === "exited" || this.lifecycle === "error") {
      return;
    }
    this.lifecycle = lifecycle;
    this.clearTimers();
    this.pending = null;
    this.emit({ activity: lifecycle }, "lifecycle");
  }

  private isLive(): boolean {
    return !this.disposed && this.lifecycle !== "exited" && this.lifecycle !== "error";
  }

  private family(): SignalFamily {
    if (this.profile !== "shell" && this.lifecycle !== "fallback") {
      return this.profile;
    }
    return this.titleFamily ?? "shell";
  }

  private startingQuietMs(): number {
    return this.family() === "shell" ? SHELL_STARTING_QUIET_MS : AGENT_STARTING_QUIET_MS;
  }

  /** The pane's own local model REPL is what answers (not its fallback
   * shell, nor an agent started by hand in it). */
  private replActive(): boolean {
    return this.repl && this.lifecycle === "running" && this.titleFamily === null;
  }

  /** A shell whose prompt has not been learned yet. (A fallback shell's
   * prompt is never needed: that pane only says "agent_fallback".) */
  private learnsPrompt(): boolean {
    return (
      this.lifecycle === "running" &&
      this.family() === "shell" &&
      !this.replActive() &&
      this.learnedPrompt === undefined
    );
  }

  /** A shell whose learned prompt is still a guess: it never came back
   * after an Enter. */
  private relearnsPrompt(): boolean {
    return (
      this.lifecycle === "running" &&
      this.family() === "shell" &&
      !this.replActive() &&
      this.learnedPrompt !== undefined &&
      !this.promptConfirmed
    );
  }

  /** The cursor line starts with the shell's prompt, text typed after it:
   * PowerShell without bracketed paste gives the prompt back with the rest
   * of a multi-line paste already on it ("PS C:\x> echo line-two"). */
  private promptLeadsCursorLine(snapshot: ScreenSnapshot): boolean {
    if (snapshot.altScreen || this.replActive()) {
      return false;
    }
    const line = snapshot.cursorLine;
    const learned = this.learnedPrompt;
    return (
      POWERSHELL_PROMPT_LEAD.test(line) ||
      (learned !== undefined && learned.trim().length >= PROMPT_LEAD_MIN_CHARS && line.startsWith(learned))
    );
  }

  /** The cursor sits right after the prompt of whatever answers in the
   * pane: a local model's REPL, or a shell. */
  private promptAtCursor(snapshot: ScreenSnapshot): boolean {
    return this.replActive()
      ? isReplPromptAtCursor(snapshot)
      : isShellPromptAtCursor(snapshot, this.learnedPrompt);
  }

  private setTitleFamily(family: AgentFamily | null): void {
    if (this.titleFamily === family) {
      return;
    }
    this.titleFamily = family;
    // An agent taking over the pane, or handing it back to the shell, starts
    // both sides from a clean slate: the Enter that launched it was not a
    // prompt for it, and the shell command it was is over when it leaves.
    this.shellWorking = false;
    this.promptSubmitted = false;
  }

  private readScreen(): ScreenSnapshot {
    try {
      return this.readScreenSource();
    } catch {
      return EMPTY_SCREEN;
    }
  }

  private evaluate(source: string): void {
    if (this.disposed || this.lifecycle === "exited" || this.lifecycle === "error") {
      return;
    }
    const now = Date.now();
    this.commit(this.resolve(now), now, source);
  }

  private resolve(now: number): Resolved {
    if (this.lifecycle === "spawning") {
      return { activity: "starting" };
    }
    const family = this.family();
    if (this.lifecycle === "fallback" && family === "shell") {
      return { activity: "agent_fallback" };
    }

    const snapshot = this.readScreen();
    const screen = classifyScreen(family, snapshot);
    if (family === "claude") {
      this.trackHookDialog(screen, now);
    }

    const title = this.title?.family === family ? this.title : null;
    const statusTitle = family !== "shell" && this.statusTitleFamilies.has(family);
    // Codex spins its title while its MCP servers boot: that is not work.
    const titleStarting =
      title?.state === "starting" ||
      (family === "codex" && title?.state === "working" && !this.promptSubmitted);
    const titleWorking = title?.state === "working" && !titleStarting;
    const titleBlocked = title?.state === "blocked";

    const screenBlocked = screen.state === "blocked" && this.startupGracePassed(now);
    if (screen.state !== "blocked") {
      this.startupBlockSince = null;
    }
    const quiet = now - this.lastOutputAt >= PROMPT_QUIET_MS;
    let promptAtCursor = family === "shell" && quiet && this.promptAtCursor(snapshot);

    if (!this.readyBySignal && this.readinessSignal(family, title, screen, screenBlocked, promptAtCursor)) {
      this.readyBySignal = true;
      this.ready = true;
    }
    if (!this.ready) {
      this.ready = this.safetyNetPassed(now);
    }
    // The prompt a quiet shell with nothing running shows at the cursor —
    // at readiness, or later for a shell whose profile took longer than the
    // safety net to draw it.
    if (this.ready && family === "shell" && quiet && !this.shellWorking && this.learnsPrompt()) {
      const line = snapshot.cursorLine;
      if (line.trim() && /\s$/u.test(line)) {
        this.learnedPrompt = line;
        promptAtCursor = this.promptAtCursor(snapshot);
      }
    }

    if (family === "shell") {
      this.trackShellWork(snapshot, promptAtCursor, quiet, now);
    }

    const hookBlock =
      family === "claude" && this.lifecycle === "running" ? this.hookBlock : null;
    if (titleBlocked || (!titleWorking && (screenBlocked || hookBlock))) {
      return {
        activity: "waiting_input",
        blocked: this.describeBlock(title, screen, hookBlock),
        tentative: !hookBlock && !title?.reason && screen.state !== "blocked",
      };
    }

    // Without a status title, the hooks' word that a turn is running stands
    // until Stop — which never comes after an Esc interrupt or decline. The
    // screen showing Claude idle at its prompt beats it.
    const hookWorking =
      hookBlock === null &&
      family === "claude" &&
      this.hookWorking &&
      screen.state !== "idle" &&
      this.lifecycle === "running";
    const guessWorking = !statusTitle && (screen.state === "working" || hookWorking);
    if (titleWorking || guessWorking || (family === "shell" && this.shellWorking)) {
      return { activity: "working" };
    }
    if (titleStarting || (screen.state === "starting" && !statusTitle) || !this.ready) {
      return { activity: "starting" };
    }
    return { activity: "idle" };
  }

  private describeBlock(
    title: TitleSignal | null,
    screen: ScreenSignal,
    hookBlock: (PaneBlock & { weak?: boolean }) | null,
  ): PaneBlock {
    const screenBlock = screen.state === "blocked" ? screen : null;
    // The hook names the tool; the screen knows a question from an approval
    // better than a bare "permission_prompt" reminder does.
    const reason =
      (hookBlock && !hookBlock.weak ? hookBlock.reason : undefined) ??
      title?.reason ??
      screenBlock?.reason ??
      hookBlock?.reason ??
      "approval";
    const detail = hookBlock?.detail ?? screenBlock?.detail;
    return detail ? { reason, detail } : { reason };
  }

  /** Something the agent (or shell) itself shows says it is up. */
  private readinessSignal(
    family: SignalFamily,
    title: TitleSignal | null,
    screen: ScreenSignal,
    screenBlocked: boolean,
    promptAtCursor: boolean,
  ): boolean {
    if (title && title.state !== "starting") {
      return true;
    }
    if (family !== "shell" && (screen.state === "idle" || screenBlocked)) {
      return true;
    }
    return promptAtCursor;
  }

  /** Nothing said it is up, but output has been quiet for a while (or it
   * has been too long since the first byte): stop saying "starting". */
  private safetyNetPassed(now: number): boolean {
    if (this.firstOutputAt === null) {
      return false;
    }
    return (
      now - this.lastOutputAt >= this.startingQuietMs() ||
      now - this.firstOutputAt >= STARTING_MAX_MS
    );
  }

  /** Before the agent said it is up, a dialog has to stay on screen for a
   * while. */
  private startupGracePassed(now: number): boolean {
    if (this.readyBySignal) {
      return true;
    }
    this.startupBlockSince ??= now;
    const remaining = this.startupBlockSince + STARTUP_BLOCK_GRACE_MS - now;
    if (remaining <= 0) {
      return true;
    }
    this.schedule("grace", remaining + 5, true);
    return false;
  }

  /** Whether the shell's foreground command (or a local model's answer) is
   * still running. */
  private trackShellWork(snapshot: ScreenSnapshot, promptAtCursor: boolean, quiet: boolean, now: number): void {
    if (this.shellWorking) {
      if (this.lastOutputAt <= this.shellEnterAt) {
        return;
      }
      if (promptAtCursor || (quiet && this.promptLeadsCursorLine(snapshot))) {
        this.shellWorking = false;
        this.replPromptAt = this.replActive() ? now : null;
        // The prompt came back after an Enter: whatever was learned is the
        // shell's own prompt for good.
        this.promptConfirmed = this.learnedPrompt !== undefined;
        return;
      }
      // The guess was wrong: the line learned at a quiet moment was a
      // question the rc asked, and the shell's real prompt ("➜  proj ") is
      // what the command came back to.
      const line = snapshot.cursorLine;
      const sigil = promptSigil(line);
      if (
        this.relearnsPrompt() &&
        now - this.lastOutputAt >= PROMPT_RELEARN_QUIET_MS &&
        !snapshot.altScreen &&
        /\s$/u.test(line) &&
        sigil !== null &&
        sigil !== promptSigil(this.learnedPrompt ?? "")
      ) {
        this.learnedPrompt = line;
        this.promptConfirmed = true;
        this.shellWorking = false;
        this.replPromptAt = null;
      }
      return;
    }
    // A local model's REPL prints its prompt only once the answer is
    // complete. Output after the prompt that seemed to end the turn — not
    // the prompt, not the echo of something typed since — means the model
    // had only paused on a lone ">" of its own and is still answering.
    if (
      this.replPromptAt !== null &&
      this.replActive() &&
      this.lastOutputAt > this.replPromptAt &&
      this.lastUserInputAt < this.replPromptAt &&
      !isReplPromptAtCursor(snapshot)
    ) {
      this.shellWorking = true;
      this.replPromptAt = null;
    }
  }

  /** A hook-reported dialog the screen recognized and then lost is over —
   * the answer did not come back as a hook (Esc on a permission does not).
   * One the screen never recognized stays until something else says so. */
  private trackHookDialog(screen: ScreenSignal, now: number): void {
    if (!this.hookBlock) {
      return;
    }
    if (screen.state === "blocked") {
      this.hookDialogSeen = true;
      this.hookDialogGoneSince = null;
      return;
    }
    if (!this.hookDialogSeen) {
      return;
    }
    this.hookDialogGoneSince ??= now;
    const remaining = this.hookDialogGoneSince + HOOK_DIALOG_GONE_MS - now;
    if (remaining <= 0) {
      this.hookBlock = null;
      this.hookDialogSeen = false;
      this.hookDialogGoneSince = null;
      return;
    }
    this.schedule("dialog-gone", remaining + 5, true);
  }

  private settleFor(from: PaneActivity, next: Resolved): number {
    const to = next.activity;
    if (to === "waiting_input" && next.tentative) {
      return TENTATIVE_BLOCK_SETTLE_MS;
    }
    if (from === "working" && to === "idle" && this.replActive()) {
      return REPL_WORKING_TO_IDLE_SETTLE_MS;
    }
    // A shell's prompt already had to hold still before it counted, and a
    // shell is never about to show a dialog.
    if (from === "working" && to === "idle" && this.family() !== "shell") {
      return WORKING_TO_IDLE_SETTLE_MS;
    }
    if (from === "waiting_input" && to === "working") {
      return BLOCKED_TO_WORKING_SETTLE_MS;
    }
    if (from === "starting" && to === "idle" && this.family() !== "shell") {
      return AGENT_READY_SETTLE_MS;
    }
    return 0;
  }

  private commit(next: Resolved, now: number, source: string): void {
    if (next.activity === this.current) {
      this.pending = null;
      this.emit(next, source);
      return;
    }
    const settle = this.settleFor(this.current, next);
    if (settle > 0) {
      if (this.pending?.activity !== next.activity) {
        this.pending = { activity: next.activity, since: now, source };
      }
      const remaining = this.pending.since + settle - now;
      if (remaining > 0) {
        this.schedule("settle", remaining + 5);
        return;
      }
      source = this.pending.source;
    }
    this.pending = null;
    this.emit(next, source);
  }

  private emit(next: Resolved, source: string): void {
    const blocked = next.activity === "waiting_input" ? next.blocked : undefined;
    if (next.activity === this.current && sameBlock(blocked, this.currentBlock)) {
      return;
    }
    this.current = next.activity;
    this.currentBlock = blocked;
    this.onChange(next.activity, blocked, {
      source,
      agentExitCode: next.activity === "agent_fallback" ? this.agentExitCode : undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  /** Re-evaluates after `delay`. `keep`: an already scheduled run stays (a
   * throttle); otherwise it is pushed back (a debounce). */
  private schedule(name: string, delay: number, keep = false): void {
    if (this.disposed) {
      return;
    }
    const existing = this.timers.get(name);
    if (existing !== undefined) {
      if (keep) {
        return;
      }
      clearTimeout(existing);
    }
    this.timers.set(
      name,
      setTimeout(() => {
        this.timers.delete(name);
        if (name === "recheck") {
          this.recheckAnsweredDialog();
        }
        this.evaluate(name);
      }, delay),
    );
  }

  /** The user pressed a key that can answer a dialog (or interrupt a turn)
   * a while ago. A hook block with no working title and no dialog on screen
   * was answered in a way that fires no hook (Esc on a permission); a turn
   * the screen no longer shows working was interrupted, and no Stop is
   * coming for it. */
  private recheckAnsweredDialog(): void {
    if (!this.hookBlock && !this.hookWorking) {
      return;
    }
    const family = this.family();
    const titleWorking = this.title?.family === family && this.title.state === "working";
    if (titleWorking) {
      return;
    }
    const screen = classifyScreen(family, this.readScreen());
    if (screen.state !== "blocked") {
      this.hookBlock = null;
      this.hookDialogSeen = false;
      this.hookDialogGoneSince = null;
    }
    // Only a screen that shows Claude back at its prompt ends the turn: one
    // it cannot read may be a long tool still running.
    if (screen.state === "idle") {
      this.hookWorking = false;
    }
  }

  private clearTimers(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
