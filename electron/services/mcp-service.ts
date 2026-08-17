import type {
  McpServersPayload,
  McpServerStatus,
  SupportedAgent,
} from "../types/api";
import { runCommand } from "./command-runner";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

export function parseClaudeMcpList(stdout: string): McpServerStatus[] {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const separator = line.indexOf(": ");
    const statusSeparator = line.lastIndexOf(" - ");
    if (separator <= 0 || statusSeparator <= separator + 2) {
      return [];
    }
    return [{
      name: line.slice(0, separator).trim(),
      target: line.slice(separator + 2, statusSeparator).trim(),
      status: line.slice(statusSeparator + 3).trim(),
    }];
  });
}

export function parseCursorMcpList(stdout: string): McpServerStatus[] {
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const separator = line.indexOf(": ");
    if (separator <= 0) {
      return [];
    }
    return [{
      name: line.slice(0, separator).trim(),
      target: "",
      status: line.slice(separator + 2).trim(),
    }];
  });
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

export type McpCommandRunner = (
  binary: string,
  cwd: string,
  timeoutMs: number,
) => Promise<CommandResult>;

function runMcpList(
  binary: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  return runCommand(binary, ["mcp", "list"], {
    cwd,
    maxBuffer: MAX_BUFFER_BYTES,
    timeoutMs,
  });
}

export interface McpServiceOptions {
  timeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
  runner?: McpCommandRunner;
}

interface CacheEntry {
  expiresAt: number;
  payload: McpServersPayload;
}

export class McpService {
  readonly #timeoutMs: number;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  readonly #runner: McpCommandRunner;
  readonly #cache = new Map<string, CacheEntry>();

  constructor(options: McpServiceOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.#now = options.now ?? Date.now;
    this.#runner = options.runner ?? runMcpList;
  }

  clearCache(): void {
    this.#cache.clear();
  }

  async list(cwd: string, agent: SupportedAgent): Promise<McpServersPayload> {
    if (!cwd || cwd.includes("\0")) {
      return { servers: [], error: "Diretório inválido" };
    }

    const key = `${agent}:${cwd}`;
    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > this.#now()) {
      return cached.payload;
    }

    const binary = agent === "claude" ? "claude" : "cursor-agent";
    const parser = agent === "claude" ? parseClaudeMcpList : parseCursorMcpList;
    let payload: McpServersPayload;
    try {
      const result = await this.#runner(binary, cwd, this.#timeoutMs);
      payload = { servers: parser(result.stdout), error: null };
    } catch (error) {
      const processError = error as NodeJS.ErrnoException & {
        killed?: boolean;
        signal?: string;
        stderr?: string;
      };
      const stderr = processError.stderr?.trim();
      const timedOut = processError.killed || processError.signal === "SIGTERM";
      payload = {
        servers: [],
        error: processError.code === "ENOENT"
          ? `CLI '${binary}' não encontrada`
          : timedOut
            ? `Tempo limite excedido ao consultar '${binary}'`
            : stderr || processError.message || `Falha ao consultar '${binary}'`,
      };
    }

    this.#cache.set(key, {
      payload,
      expiresAt: this.#now() + this.#cacheTtlMs,
    });
    return payload;
  }
}

export const mcpService = new McpService();
export const listMcpServers = mcpService.list.bind(mcpService);
