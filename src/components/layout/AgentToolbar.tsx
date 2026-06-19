import { clearAgentSession } from "../../actions/clearAgentSession";
import { CLEAR_SHORTCUT } from "../../config/toolbar";
import { useSessionStore } from "../../core/session-manager";

export function AgentToolbar() {
  const splitActivePane = useSessionStore((state) => state.splitActivePane);

  return (
    <header className="agent-toolbar">
      <div className="agent-toolbar__brand">
        <span className="agent-toolbar__dot" aria-hidden />
        <span className="agent-toolbar__title">
          Head Terminal{import.meta.env.DEV ? " (Dev)" : ""}
        </span>
      </div>

      <div className="agent-toolbar__actions">
        <button
          type="button"
          className="agent-toolbar__button"
          title={`Reiniciar sessão do zero (${CLEAR_SHORTCUT})`}
          onClick={() => clearAgentSession()}
        >
          Clear
        </button>

        <button
          type="button"
          className="agent-toolbar__button agent-toolbar__button--ghost"
          title="Dividir verticalmente"
          onClick={() => splitActivePane("vertical")}
        >
          Split ↓
        </button>

        <button
          type="button"
          className="agent-toolbar__button agent-toolbar__button--ghost"
          title="Dividir horizontalmente"
          onClick={() => splitActivePane("horizontal")}
        >
          Split →
        </button>
      </div>
    </header>
  );
}
