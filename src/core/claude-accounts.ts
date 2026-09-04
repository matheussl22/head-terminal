import { joinPath } from "./path-utils";
import { getCachedPlatformInfo } from "./platform-info";

const STORAGE_KEY = "head-terminal.claude-accounts";
const DEFAULT_NAME_KEY = "head-terminal.claude-default-account-name";

export const DEFAULT_CLAUDE_ACCOUNT_ID = "default";

export interface ClaudeAccountProfile {
  id: string;
  name: string;
  /** `CLAUDE_CONFIG_DIR` for panes on this profile. Always under
   * `~/.head-terminal/claude-profiles/` — never the user's own `~/.claude`.
   * Absent only while the host's home directory is still unknown. */
  configDir?: string;
}

const DEFAULT_PROFILE_NAME = "Conta padrão";

/**
 * Every profile, the default included, lives in its own directory. A pane
 * that used the machine-global `~/.claude` would share login, history and
 * settings with every terminal the user opens outside Head Terminal — a
 * `/login` in a pane would switch the account of those terminals too. The
 * default profile is therefore just the profile with a fixed id.
 */
export function claudeProfileConfigDir(home: string, id: string): string {
  return joinPath(home, ".head-terminal", "claude-profiles", id);
}

function defaultProfile(): ClaudeAccountProfile {
  const savedName =
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(DEFAULT_NAME_KEY)?.trim();
  const home = getCachedPlatformInfo()?.homeDir;
  return {
    id: DEFAULT_CLAUDE_ACCOUNT_ID,
    name: savedName || DEFAULT_PROFILE_NAME,
    configDir: home ? claudeProfileConfigDir(home, DEFAULT_CLAUDE_ACCOUNT_ID) : undefined,
  };
}

function loadCustomProfiles(): ClaudeAccountProfile[] {
  if (typeof localStorage === "undefined") {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (profile): profile is ClaudeAccountProfile =>
        typeof profile === "object" &&
        profile !== null &&
        typeof (profile as ClaudeAccountProfile).id === "string" &&
        typeof (profile as ClaudeAccountProfile).name === "string" &&
        typeof (profile as ClaudeAccountProfile).configDir === "string",
    );
  } catch {
    return [];
  }
}

export function loadClaudeAccountProfiles(): ClaudeAccountProfile[] {
  return [defaultProfile(), ...loadCustomProfiles()];
}

function validateName(
  name: string,
  profiles: ClaudeAccountProfile[],
  currentId?: string,
): string {
  const trimmedName = name.trim();
  if (!trimmedName || trimmedName.length > 40) {
    throw new Error("Informe um nome de até 40 caracteres");
  }
  if (
    profiles.some(
      (profile) =>
        profile.id !== currentId &&
        profile.name.toLocaleLowerCase() === trimmedName.toLocaleLowerCase(),
    )
  ) {
    throw new Error("Já existe um perfil com esse nome");
  }
  return trimmedName;
}

export function createClaudeAccountProfile(
  name: string,
  home: string,
): ClaudeAccountProfile {
  const profiles = loadCustomProfiles();
  const trimmedName = validateName(name, loadClaudeAccountProfiles());

  const id = crypto.randomUUID();
  const profile = {
    id,
    name: trimmedName,
    configDir: claudeProfileConfigDir(home, id),
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify([...profiles, profile]));
  return profile;
}

export function renameClaudeAccountProfile(id: string, name: string): void {
  const profiles = loadClaudeAccountProfiles();
  const trimmedName = validateName(name, profiles, id);

  if (id === DEFAULT_CLAUDE_ACCOUNT_ID) {
    localStorage.setItem(DEFAULT_NAME_KEY, trimmedName);
    return;
  }

  const customProfiles = loadCustomProfiles();
  if (!customProfiles.some((profile) => profile.id === id)) {
    throw new Error("Perfil Claude não encontrado");
  }
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(
      customProfiles.map((profile) =>
        profile.id === id ? { ...profile, name: trimmedName } : profile,
      ),
    ),
  );
}

export function deleteClaudeAccountProfile(id: string): void {
  if (id === DEFAULT_CLAUDE_ACCOUNT_ID) {
    throw new Error("A conta padrão não pode ser excluída");
  }

  const profiles = loadCustomProfiles();
  if (!profiles.some((profile) => profile.id === id)) {
    throw new Error("Perfil Claude não encontrado");
  }
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(profiles.filter((profile) => profile.id !== id)),
  );
}

export function getClaudeAccountProfile(
  id?: string,
): ClaudeAccountProfile | undefined {
  const targetId = id ?? DEFAULT_CLAUDE_ACCOUNT_ID;
  return loadClaudeAccountProfiles().find((profile) => profile.id === targetId);
}

/**
 * The `CLAUDE_CONFIG_DIR` a pane on this profile must run with. Never
 * `undefined`: falling back to the CLI's default would be exactly the leak
 * into the user's global `~/.claude` that profiles exist to prevent, so an
 * unresolvable directory is an error the caller shows instead of a spawn.
 */
export function resolveClaudeConfigDir(id?: string): string {
  const profile = getClaudeAccountProfile(id);
  if (!profile) {
    throw new Error("Perfil Claude não encontrado. Escolha outro perfil nas configurações.");
  }
  if (!profile.configDir) {
    throw new Error(
      "Diretório do perfil Claude indisponível: a pasta do usuário ainda não é conhecida.",
    );
  }
  return profile.configDir;
}
