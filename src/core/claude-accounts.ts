const STORAGE_KEY = "head-terminal.claude-accounts";
const DEFAULT_NAME_KEY = "head-terminal.claude-default-account-name";

export const DEFAULT_CLAUDE_ACCOUNT_ID = "default";

export interface ClaudeAccountProfile {
  id: string;
  name: string;
  configDir?: string;
}

const DEFAULT_PROFILE_NAME = "Conta padrão (global)";

function defaultProfile(): ClaudeAccountProfile {
  const savedName =
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(DEFAULT_NAME_KEY)?.trim();
  return {
    id: DEFAULT_CLAUDE_ACCOUNT_ID,
    name: savedName || DEFAULT_PROFILE_NAME,
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
    configDir: `${home.replace(/\/+$/, "")}/.head-terminal/claude-profiles/${id}`,
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

export function resolveClaudeConfigDir(id?: string): string | undefined {
  const profile = getClaudeAccountProfile(id);
  if (!profile) {
    throw new Error("Perfil Claude não encontrado. Escolha outro perfil nas configurações.");
  }
  return profile.configDir;
}
