import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import {
  fetchResumableSessions,
  isResumableAgent,
  type ResumableSessionEntry,
} from "../../core/agent-sessions-bridge";
import {
  CONVERSATION_LABEL_MAX_LENGTH,
  useSessionStore,
} from "../../core/session-manager";
import { IconChevronDown, IconPencil } from "../ui/Icons";

interface ResumeSessionMenuProps {
  paneId: string;
  agentProfileId: string;
  cwd: string;
  claudeAccountId?: string;
}

interface MenuPosition {
  right: number;
  top: number;
}

/** Exact stamp, for the tooltip and for rows a relative label can't tell
 * apart. Seconds are in there on purpose: a batch of conversations fanned out
 * across panes lands inside the same minute. */
function formatExactLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const date = new Date(ms);
  const clock = date.toLocaleTimeString("pt-BR");
  if (date.toDateString() === new Date().toDateString()) {
    return clock;
  }
  const day = date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });
  return `${day} ${clock}`;
}

function formatRelativeLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const diffMinutes = Math.round((Date.now() - ms) / 60_000);
  if (diffMinutes < 1) return "agora";
  if (diffMinutes < 60) return `${diffMinutes} min atrás`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} h atrás`;
  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 30) return `${diffDays} d atrás`;
  return new Date(ms).toLocaleDateString("pt-BR");
}

export function ResumeSessionMenu({
  paneId,
  agentProfileId,
  cwd,
  claudeAccountId,
}: ResumeSessionMenuProps) {
  const resumePane = useSessionStore((state) => state.resumePane);
  const conversationLabels = useSessionStore(
    (state) => state.conversationLabels,
  );
  const setConversationLabel = useSessionStore(
    (state) => state.setConversationLabel,
  );
  const noteConversationTitles = useSessionStore(
    (state) => state.noteConversationTitles,
  );
  const currentSessionId = useSessionStore(
    (state) => state.paneResumeAnchors[paneId],
  );
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [entries, setEntries] = useState<ResumableSessionEntry[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

  const close = useCallback(() => {
    setPosition(null);
    setEditingId(null);
  }, []);

  useEffect(() => {
    if (!position) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [position, close]);

  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  if (!isResumableAgent(agentProfileId)) {
    return null;
  }

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setPosition({ right: window.innerWidth - rect.right, top: rect.bottom + 4 });
    setEntries(null);

    const requestId = ++requestIdRef.current;
    void fetchResumableSessions(cwd, agentProfileId, claudeAccountId)
      .catch(() => [])
      .then((result) => {
        if (requestIdRef.current === requestId) {
          setEntries(result);
          // Same lookup the pane header needs for its own name — cache it once
          // so opening this menu doubles as a refresh for every pane on this cwd.
          noteConversationTitles(result);
        }
      });
  };

  const displayNames = new Map<string, number>();
  for (const entry of entries ?? []) {
    const name = conversationLabels[entry.id] ?? entry.title;
    displayNames.set(name, (displayNames.get(name) ?? 0) + 1);
  }

  const commitRename = (entryId: string) => {
    setConversationLabel(entryId, draft);
    setEditingId(null);
  };

  return (
    <>
      <button
        type="button"
        className="terminal-pane-header__action"
        title="Retomar uma sessão anterior"
        aria-label="Retomar uma sessão anterior"
        onClick={open}
      >
        <IconChevronDown size={13} />
      </button>
      {position && (
        <div
          ref={menuRef}
          className="resume-session-menu"
          style={{ right: position.right, top: position.top }}
          role="menu"
        >
          {entries === null && (
            <div className="resume-session-menu__empty">Carregando…</div>
          )}
          {entries?.length === 0 && (
            <div className="resume-session-menu__empty">
              Nenhuma sessão anterior encontrada
            </div>
          )}
          {entries?.map((entry) => {
            const label = conversationLabels[entry.id];
            const isCurrent = entry.id === currentSessionId;
            const name = label ?? entry.title;
            // Two conversations can still read the same — the user gave them
            // the same name, or they were opened with the exact same prompt
            // and there is nothing left to tell them apart by. Those rows
            // trade the friendly "1 d atrás" for the clock.
            const ambiguous = displayNames.get(name)! > 1;

            if (editingId === entry.id) {
              return (
                <div key={entry.id} className="resume-session-menu__row">
                  <input
                    ref={inputRef}
                    className="resume-session-menu__rename-input"
                    value={draft}
                    maxLength={CONVERSATION_LABEL_MAX_LENGTH}
                    placeholder="Nome da conversa"
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => commitRename(entry.id)}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitRename(entry.id);
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditingId(null);
                      }
                    }}
                  />
                </div>
              );
            }

            return (
              <div
                key={entry.id}
                className={
                  isCurrent
                    ? "resume-session-menu__row resume-session-menu__row--current"
                    : "resume-session-menu__row"
                }
              >
                <button
                  type="button"
                  className="resume-session-menu__item"
                  role="menuitem"
                  title={[
                    name,
                    formatExactLabel(entry.updatedAt),
                    isCurrent ? "Conversa atual deste terminal" : "",
                  ]
                    .filter(Boolean)
                    .join("\n")}
                  onClick={() => {
                    resumePane(paneId, entry.id);
                    close();
                  }}
                >
                  <span className="resume-session-menu__item-title">
                    {name}
                  </span>
                  <span className="resume-session-menu__item-time">
                    {ambiguous
                      ? formatExactLabel(entry.updatedAt)
                      : formatRelativeLabel(entry.updatedAt)}
                  </span>
                </button>
                <button
                  type="button"
                  className="resume-session-menu__rename"
                  title="Renomear conversa (vazio volta ao nome automático)"
                  aria-label={`Renomear ${name}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setDraft(name);
                    setEditingId(entry.id);
                  }}
                >
                  <IconPencil size={11} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
