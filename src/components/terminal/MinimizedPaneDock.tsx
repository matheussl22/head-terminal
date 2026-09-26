import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { formatBranchLabel } from "../../core/git-context-utils";
import { describeMinimizedPane, minimizedPaneTicks } from "../../core/minimized-panes";
import { landPaneMotion, restorePaneWithMotion } from "../../core/pane-minimize";
import { basenamePath } from "../../core/path-utils";
import { resolvePaneCwd } from "../../core/session-layout";
import { useSessionStore } from "../../core/session-manager";
import { formatShortcut } from "../../core/shortcuts";
import { usePaneConversation } from "../../hooks/usePaneConversation";
import type { AgentSession } from "../../types/session";
import {
  IconCheck,
  IconFolder,
  IconGitBranch,
  IconRestoreFromDock,
} from "../ui/Icons";
import { AgentIcon, paneShortLabel } from "./TerminalPaneChrome";

/** "bar": a row under the terminals still on screen. "stage": every terminal
 * of the session is minimized, so the cards take the middle of the canvas. */
export type MinimizedDockVariant = "bar" | "stage";

interface MinimizedPaneDockProps {
  session: AgentSession;
  /** The session's minimized panes, in layout order. */
  paneIds: string[];
  /** Each pane's position in the layout: the number in its label (cc2). */
  paneIndexById: ReadonlyMap<string, number>;
  variant: MinimizedDockVariant;
}

/** Where the session keeps an eye on its minimized terminals: one card per
 * terminal, saying whether its agent is still at it, and loud once it stops. */
export function MinimizedPaneDock({
  session,
  paneIds,
  paneIndexById,
  variant,
}: MinimizedPaneDockProps) {
  const cards = paneIds.map((paneId) => (
    <MinimizedPaneCard
      key={paneId}
      session={session}
      paneId={paneId}
      paneIndex={paneIndexById.get(paneId) ?? 0}
      variant={variant}
    />
  ));

  if (variant === "stage") {
    return (
      <section className="minimized-stage" aria-label="Terminais minimizados">
        <div className="minimized-stage__heading">
          <span className="minimized-stage__title">
            {paneIds.length === 1
              ? "Terminal minimizado"
              : `${paneIds.length} terminais minimizados`}
          </span>
          {paneIds.length === 1 ? (
            <span className="minimized-stage__hint">
              O agent segue rodando. Clique no card ou use{" "}
              <kbd>{formatShortcut("Ctrl+Shift+M")}</kbd> para restaurar.
            </span>
          ) : (
            <span className="minimized-stage__hint">
              Os agents seguem rodando. Clique num card para restaurar —{" "}
              <kbd>{formatShortcut("Ctrl+Shift+M")}</kbd> traz o último.
            </span>
          )}
        </div>
        <div className="minimized-stage__cards">{cards}</div>
      </section>
    );
  }

  return (
    <section className="minimized-dock" aria-label="Terminais minimizados">
      {cards}
    </section>
  );
}

/** Wall clock that only ticks while something on the card counts time. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  return now;
}

function MinimizedPaneCard({
  session,
  paneId,
  paneIndex,
  variant,
}: {
  session: AgentSession;
  paneId: string;
  paneIndex: number;
  variant: MinimizedDockVariant;
}) {
  const runtime = useSessionStore((state) => state.paneRuntime[paneId]);
  const minimized = useSessionStore((state) => state.minimizedPanes[paneId]);
  const gitContext = useSessionStore((state) => state.paneGitContext[paneId]);
  const cwd = resolvePaneCwd(session, paneId);
  const conversation = usePaneConversation({
    paneId,
    cwd,
    agentProfileId: session.agentProfileId,
    claudeAccountId: session.claudeAccountId,
  });
  const cardRef = useRef<HTMLButtonElement>(null);
  const now = useNow(minimizedPaneTicks(runtime));

  // Mounting is the end of a minimize: the ghost lands here.
  useLayoutEffect(() => {
    landPaneMotion(paneId, "minimize", cardRef.current);
  }, [paneId]);

  if (!minimized) {
    return null;
  }

  const status = describeMinimizedPane(runtime, minimized, now);
  const shortLabel = paneShortLabel(session.agentProfileId, paneIndex);
  const folder = basenamePath(cwd, cwd);
  const conversationName = conversation.supported ? conversation.name : null;
  const name = conversationName ?? folder;
  const branch = formatBranchLabel(gitContext);
  const statusText = status.time ? `${status.label} ${status.time}` : status.label;

  const classes = [
    "minimized-card",
    `minimized-card--${variant}`,
    `minimized-card--${status.tone}`,
    status.attention ? "minimized-card--attention" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={cardRef}
      type="button"
      className={classes}
      data-minimized-pane={paneId}
      title={`${shortLabel} · ${name} — ${statusText}. Clique para restaurar.`}
      aria-label={`Restaurar ${shortLabel} (${statusText})`}
      onClick={() => restorePaneWithMotion(paneId)}
    >
      {/* Same tinted chip as the pane header, so the card reads as that terminal. */}
      <span
        className={`minimized-card__agent terminal-pane-header__agent terminal-pane-header__agent--${session.agentProfileId}`}
      >
        <AgentIcon
          agentProfileId={session.agentProfileId}
          size={variant === "stage" ? 14 : 12}
        />
      </span>

      <span className="minimized-card__text">
        <span className="minimized-card__title">
          <span className="minimized-card__label">{shortLabel}</span>
          <span
            className={
              conversationName
                ? "minimized-card__name"
                : "minimized-card__name minimized-card__name--folder"
            }
          >
            {name}
          </span>
        </span>
        {variant === "stage" && (conversationName || branch) && (
          <span className="minimized-card__meta">
            {conversationName && (
              <span className="minimized-card__meta-item">
                <IconFolder size={11} />
                <span>{folder}</span>
              </span>
            )}
            {branch && (
              <span className="minimized-card__meta-item">
                <IconGitBranch size={11} />
                <span>{branch}</span>
              </span>
            )}
          </span>
        )}
      </span>

      <span className="minimized-card__status">
        {status.tone === "done" ? (
          <IconCheck size={11} className="minimized-card__check" />
        ) : (
          <span className="minimized-card__dot" aria-hidden />
        )}
        <span>{status.label}</span>
        {status.time && <span className="minimized-card__time">{status.time}</span>}
      </span>

      <span className="minimized-card__restore" aria-hidden>
        <IconRestoreFromDock size={13} />
      </span>

      {status.tone === "working" && (
        <span className="minimized-card__progress" aria-hidden />
      )}
    </button>
  );
}
