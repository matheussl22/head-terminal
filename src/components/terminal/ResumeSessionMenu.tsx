import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

import {
  fetchResumableSessions,
  isResumableAgent,
  type ResumableSessionEntry,
} from "../../core/agent-sessions-bridge";
import { useSessionStore } from "../../core/session-manager";
import { IconChevronDown } from "../ui/Icons";

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
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const [entries, setEntries] = useState<ResumableSessionEntry[] | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const requestIdRef = useRef(0);

  const close = useCallback(() => setPosition(null), []);

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
        }
      });
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
          {entries?.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="resume-session-menu__item"
              role="menuitem"
              onClick={() => {
                resumePane(paneId, entry.id);
                close();
              }}
            >
              <span className="resume-session-menu__item-title">{entry.title}</span>
              <span className="resume-session-menu__item-time">
                {formatRelativeLabel(entry.updatedAt)}
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
