import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type MouseEvent,
  type Ref,
} from "react";

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

/** Lets another control open the list — the pane's "⋯" menu does, when the
 * header is too narrow to show this menu's own chevron. */
export interface ResumeSessionMenuHandle {
  openAt: (anchor: MenuAnchor) => void;
}

interface ResumeSessionMenuProps {
  paneId: string;
  agentProfileId: string;
  cwd: string;
  claudeAccountId?: string;
  handleRef?: Ref<ResumeSessionMenuHandle>;
  /** The pane is on screen: its session is the one shown, and it is neither
   * in the dock nor parked behind a zoomed sibling. The list closes when it
   * stops being — it would otherwise stay open where nobody sees it, still
   * holding Esc. */
  onScreen?: boolean;
}

export interface MenuPosition {
  right: number;
  top: number;
  /** Room left on the side the menu opens to, so a long list scrolls instead
   * of running off the window. */
  maxHeight: number;
}

/** The trigger's box, as getBoundingClientRect gives it. */
export interface MenuAnchor {
  right: number;
  bottom: number;
  top?: number;
}

const MENU_VIEWPORT_MARGIN_PX = 12;
const MENU_MAX_HEIGHT_PX = 600;
const MENU_MIN_HEIGHT_PX = 160;
const RESUME_MENU_WIDTH_PX = 440;

/**
 * Where a menu opens: 4px under its trigger, right edges aligned. With the
 * menu's size known it also stays on screen — shifted left when the trigger
 * sits near the left edge, and flipped above the trigger when it doesn't fit
 * below but does (better) above.
 */
export function resolveMenuPosition(
  rect: MenuAnchor,
  viewport: { width: number; height: number },
  menu: { width?: number; height?: number } = {},
): MenuPosition {
  let right = Math.max(MENU_VIEWPORT_MARGIN_PX, viewport.width - rect.right);
  if (menu.width !== undefined) {
    right = Math.max(
      MENU_VIEWPORT_MARGIN_PX,
      Math.min(right, viewport.width - MENU_VIEWPORT_MARGIN_PX - menu.width),
    );
  }

  const below = rect.bottom + 4;
  const roomBelow = viewport.height - below - MENU_VIEWPORT_MARGIN_PX;
  if (menu.height !== undefined && rect.top !== undefined && menu.height > roomBelow) {
    const roomAbove = rect.top - 4 - MENU_VIEWPORT_MARGIN_PX;
    if (roomAbove > roomBelow) {
      const height = Math.min(menu.height, roomAbove, MENU_MAX_HEIGHT_PX);
      return { right, top: rect.top - 4 - height, maxHeight: height };
    }
  }

  return {
    right,
    top: below,
    maxHeight: Math.max(MENU_MIN_HEIGHT_PX, Math.min(MENU_MAX_HEIGHT_PX, roomBelow)),
  };
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
  handleRef,
  onScreen = true,
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
  const triggerRef = useRef<HTMLButtonElement>(null);
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
      const target = event.target as Node;
      // The trigger is left to its own click handler, which toggles the menu
      // shut — closing here as well would reopen it on the same click.
      if (triggerRef.current?.contains(target)) {
        return;
      }
      if (menuRef.current && !menuRef.current.contains(target)) {
        close();
      }
    };
    // Capture phase: the keyboard is usually still in this pane's terminal
    // (the list opens from the header, or from "⋯"), and xterm would send the
    // Esc to the agent — interrupting its turn or declining its question —
    // and swallow it before a bubbling listener ever saw it. The rename field
    // inside the list handles its own Esc (cancel the rename, keep the list).
    // Only an Esc from the list or from this pane is for the list, or one
    // with the keyboard nowhere (opening it from "⋯" unmounts the item that
    // had the focus). One typed in the palette, a rename in the sidebar or
    // another pane's terminal belongs there.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      const target = event.target instanceof Node ? event.target : null;
      const inList = Boolean(target && menuRef.current?.contains(target));
      if (inList && target instanceof HTMLInputElement) {
        return;
      }
      const pane = triggerRef.current?.closest(".terminal-pane-shell");
      const inPane = Boolean(target && pane?.contains(target));
      const nowhere =
        !target || target === document.body || target === document.documentElement;
      if (!inList && !inPane && !nowhere) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [position, close]);

  // Ctrl+Tab to another session, Ctrl+Shift+M, a notification revealing a
  // pane elsewhere: none is a click outside the list, and the list goes off
  // screen with its pane — open, and still taking the next Esc.
  useEffect(() => {
    if (!onScreen) {
      close();
    }
  }, [onScreen, close]);

  useEffect(() => {
    if (editingId) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editingId]);

  const openAt = (anchor: MenuAnchor) => {
    setPosition(
      resolveMenuPosition(
        anchor,
        { width: window.innerWidth, height: window.innerHeight },
        { width: Math.min(RESUME_MENU_WIDTH_PX, window.innerWidth - 24) },
      ),
    );
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

  useImperativeHandle(handleRef, () => ({ openAt }));

  if (!isResumableAgent(agentProfileId)) {
    return null;
  }

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (position) {
      close();
      return;
    }
    openAt(event.currentTarget.getBoundingClientRect());
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
        ref={triggerRef}
        type="button"
        className="terminal-pane-header__action"
        data-pane-action="history"
        title="Histórico de conversas desta pasta"
        aria-label="Histórico de conversas desta pasta"
        aria-haspopup="menu"
        aria-expanded={position !== null}
        onClick={open}
      >
        <IconChevronDown size={13} />
      </button>
      {position && (
        <div
          ref={menuRef}
          className="resume-session-menu"
          style={{
            right: position.right,
            top: position.top,
            maxHeight: position.maxHeight,
          }}
          role="menu"
          onClick={(event) => {
            // The list lives inside the pane header, whose click activates the
            // pane and hands the keyboard to its terminal. A click on the list
            // itself (its padding, "Carregando…", the rename field) is not
            // that; picking a conversation is, and still gets there.
            if (!(event.target as HTMLElement).closest("button")) {
              event.stopPropagation();
            }
          }}
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
                    `Iniciada em ${formatExactLabel(entry.createdAt)}`,
                    entry.updatedAt !== entry.createdAt
                      ? `Última atividade ${formatExactLabel(entry.updatedAt)}`
                      : "",
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
                    {/* The row shows the same stamp the list is sorted by,
                        otherwise a resumed conversation reads "agora" while
                        sitting halfway down the list. */}
                    {ambiguous
                      ? formatExactLabel(entry.createdAt)
                      : formatRelativeLabel(entry.createdAt)}
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
