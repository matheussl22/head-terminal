import { useState } from "react";

import { buildAgentProfiles } from "../../config/agents";

interface CreateSessionDialogProps {
  open: boolean;
  defaultCwd: string;
  onClose: () => void;
  onCreate: (cwd: string, agentProfileId: string) => void;
}

export function CreateSessionDialog({
  open,
  defaultCwd,
  onClose,
  onCreate,
}: CreateSessionDialogProps) {
  const [cwd, setCwd] = useState(defaultCwd);
  const [agentProfileId, setAgentProfileId] = useState("cursor");

  if (!open) {
    return null;
  }

  const profiles = Object.values(buildAgentProfiles());

  return (
    <div className="create-session-backdrop" onClick={onClose}>
      <div
        className="create-session-dialog"
        role="dialog"
        aria-label="Nova sessão"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="create-session-dialog__title">Nova sessão</h2>

        <label className="create-session-dialog__field">
          <span>Diretório</span>
          <input
            type="text"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="/home/user/projeto"
          />
        </label>

        <label className="create-session-dialog__field">
          <span>Agent</span>
          <select
            value={agentProfileId}
            onChange={(event) => setAgentProfileId(event.target.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
          </select>
        </label>

        <div className="create-session-dialog__actions">
          <button type="button" className="agent-toolbar__button--ghost" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="button"
            className="agent-toolbar__button"
            onClick={() => {
              onCreate(cwd.trim() || defaultCwd, agentProfileId);
              onClose();
            }}
          >
            Criar
          </button>
        </div>
      </div>
    </div>
  );
}
