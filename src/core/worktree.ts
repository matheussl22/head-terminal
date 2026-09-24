import { getSessionActivity } from "./activity-utils";
import { confirmInApp } from "./confirm-dialog";
import { logError, logEvent } from "./logger";
import {
  collectPaneIds,
  collectPaneWorktrees,
  findPaneNode,
  resolvePaneCwd,
} from "./session-layout";
import { useSessionStore } from "./session-manager";
import type { AgentSession, WorktreeRef } from "../types/session";
import type { WorktreePlan } from "../../electron/types/api";

/** Depois de fechar o terminal o processo ainda leva um instante para morrer, e
 * no Windows não se apaga uma pasta que é o cwd de um processo vivo. */
const REMOVAL_RETRY_DELAYS_MS = [120, 400, 1_000];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Onde cada terminal aberto está rodando agora, um por terminal.
 *
 * São as pastas dos panes, não a das sessões: a pasta de uma sessão cujos
 * terminais foram todos para outro lugar é só o padrão do próximo terminal, e
 * ninguém está trabalhando nela. O processo principal resolve cada caminho até
 * a raiz da sua árvore antes de comparar, então um subdiretório do repo conta
 * como o repo, e um worktree conta à parte. */
export function collectOccupiedCwds(
  sessions: readonly AgentSession[],
  options: { excludeSessionId?: string; excludePaneId?: string } = {},
): string[] {
  const occupied: string[] = [];

  for (const session of sessions) {
    if (session.id === options.excludeSessionId) {
      continue;
    }
    for (const paneId of collectPaneIds(session.layout)) {
      // Um terminal que está se isolando não conta como ocupante de si mesmo.
      if (paneId === options.excludePaneId) {
        continue;
      }
      // Uma entrada por terminal, repetida de propósito: o plano conta agents
      // na árvore, e três terminais na mesma pasta são três, não um.
      occupied.push(resolvePaneCwd(session, paneId));
    }
  }

  return occupied;
}

/** Este diretório precisa de árvore própria, dado o que já está aberto? */
export async function planWorktree(
  cwd: string,
  options: { excludeSessionId?: string; excludePaneId?: string } = {},
): Promise<WorktreePlan> {
  const { sessions } = useSessionStore.getState();
  return window.headTerminal.git.planWorktree({
    cwd,
    occupiedCwds: collectOccupiedCwds(sessions, options),
  });
}

/** Cria a árvore isolada deste diretório. Se o git recusar, o usuário decide se
 * tenta de novo; desistir devolve `null`. */
export async function createIsolatedWorktree(
  cwd: string,
): Promise<WorktreeRef | null> {
  // Sem teto de tentativas: cada volta exige um clique do usuário, e um limite
  // interno só produziria um último "tentar de novo" que não tentaria nada.
  for (;;) {
    try {
      const info = await window.headTerminal.git.createWorktree(cwd, {
        copyIgnored: true,
      });
      logEvent("info", "worktree.created", {
        path: info.path,
        branch: info.branch,
        copiedFiles: info.copiedFiles,
      });
      return {
        path: info.path,
        branch: info.branch,
        mainRepoRoot: info.mainRepoRoot,
      };
    } catch (error) {
      logError("worktree.create_failed", error);
      const retry = await window.headTerminal.system.confirm({
        title: "Não foi possível criar o worktree",
        message: `O git recusou criar a árvore isolada de ${cwd}.`,
        detail: error instanceof Error ? error.message : String(error),
        confirmLabel: "Tentar de novo",
        cancelLabel: "Deixar como está",
      });
      if (!retry) {
        return null;
      }
    }
  }
}

/** Move a sessão inteira para uma árvore isolada e reinicia os terminais lá. */
export async function isolateSessionInWorktree(
  sessionId: string,
): Promise<WorktreeRef | null> {
  const session = useSessionStore
    .getState()
    .sessions.find((item) => item.id === sessionId);
  if (!session) {
    return null;
  }

  const worktree = await createIsolatedWorktree(session.cwd);
  if (worktree) {
    useSessionStore.getState().adoptSessionWorktree(sessionId, worktree);
  }
  return worktree;
}

/** O mesmo para um terminal só: o cabeçalho passa a mostrar a pasta nova. */
export async function isolatePaneInWorktree(
  paneId: string,
): Promise<WorktreeRef | null> {
  const session = useSessionStore
    .getState()
    .sessions.find((item) => findPaneNode(item.layout, paneId) !== null);
  if (!session) {
    return null;
  }

  const worktree = await createIsolatedWorktree(resolvePaneCwd(session, paneId));
  if (worktree) {
    useSessionStore.getState().adoptPaneWorktree(paneId, worktree);
  }
  return worktree;
}

export interface WorktreeCloseDecision {
  /** `false` quando o usuário desistiu de fechar. */
  proceed: boolean;
  /** O que remover depois que o terminal ou a sessão sair do ar. */
  remove: WorktreeRef[];
}

/** Pergunta o que fazer com as árvores criadas pelo app, sem mexer em nada.
 *
 * Árvore limpa e sem commit exclusivo: oferece remover, pasta e branch juntas.
 * Árvore com trabalho que só existe ali: nunca some sozinha — o usuário escolhe
 * entre fechar assim mesmo (a pasta fica) ou cancelar e ir publicar antes. */
export async function decideWorktreesOnClose(
  worktrees: readonly WorktreeRef[],
  context: { label: string },
): Promise<WorktreeCloseDecision> {
  const remove: WorktreeRef[] = [];

  for (const worktree of worktrees) {
    let status;
    try {
      status = await window.headTerminal.git.worktreeStatus(worktree.path);
    } catch (error) {
      logError("worktree.status_failed", error);
      continue;
    }

    if (!status.exists) {
      continue;
    }

    if (status.safeToRemove) {
      // A branch em check-out pode não ser mais a que o app criou; o serviço só
      // apaga quando ainda bate, então o texto não promete mais do que isso.
      const onOwnBranch = status.branch === worktree.branch;
      const confirmed = await window.headTerminal.system.confirm({
        title: "Remover o worktree?",
        message: `${context.label} usava a árvore isolada ${worktree.branch}.`,
        detail: onOwnBranch
          ? `Nada ficou para trás: sem alteração pendente e sem commit que só exista aqui.\n\nRemover apaga a pasta ${worktree.path} e a branch ${worktree.branch}.`
          : `Nada ficou para trás: sem alteração pendente e sem commit que só exista aqui.\n\nRemover apaga a pasta ${worktree.path}. A branch ${worktree.branch} fica, porque o worktree está em ${status.branch ?? "HEAD solto"} agora.`,
        confirmLabel: "Remover worktree",
        cancelLabel: "Manter pasta",
      });
      if (confirmed) {
        remove.push(worktree);
      }
      continue;
    }

    const pending = [
      status.isDirty ? "alterações não commitadas" : null,
      status.unpushedCommits > 0
        ? `${status.unpushedCommits} commit(s) que não estão em nenhum outro lugar`
        : null,
    ]
      .filter(Boolean)
      .join(" e ");

    const keepAndClose = await window.headTerminal.system.confirm({
      title: "Worktree com trabalho não publicado",
      message: `${status.branch ?? worktree.branch} tem ${pending}.`,
      detail:
        `A pasta ${worktree.path} será mantida — nada é apagado.\n\n` +
        `Cancele se preferir commitar ou publicar antes de fechar.`,
      confirmLabel: "Fechar e manter a pasta",
      cancelLabel: "Cancelar",
    });
    if (!keepAndClose) {
      return { proceed: false, remove: [] };
    }
  }

  return { proceed: true, remove };
}

/** Remove as árvores que o usuário mandou remover, já com o terminal fechado.
 *
 * As tentativas espaçadas são pela morte do processo: o shell ainda está saindo
 * quando esta função começa, e enquanto ele viver a pasta é o cwd dele — no
 * Windows isso faz o `git worktree remove` falhar com recurso ocupado. Sem
 * `--force` de propósito: se o agent escreveu alguma coisa entre a pergunta e
 * agora, a remoção falhar é o resultado certo. */
async function removeWorktrees(
  worktrees: readonly WorktreeRef[],
): Promise<void> {
  for (const worktree of worktrees) {
    // Enquanto o usuário quiser insistir: ele pediu a remoção e, sem isso, um
    // clique em "Remover worktree" poderia acabar sem pasta removida e sem
    // nada dito a respeito.
    for (;;) {
      const error = await attemptRemoval(worktree);
      if (!error) {
        break;
      }
      logError("worktree.remove_failed", error, { path: worktree.path });
      const retry = await window.headTerminal.system.confirm({
        title: "Não foi possível remover o worktree",
        message: `A pasta ${worktree.path} continua no disco.`,
        detail:
          `${error instanceof Error ? error.message : String(error)}\n\n` +
          `Se algum programa ainda estiver com a pasta aberta, feche e tente de novo — ou remova depois com: git worktree remove ${worktree.path}`,
        confirmLabel: "Tentar de novo",
        cancelLabel: "Deixar a pasta",
      });
      if (!retry) {
        break;
      }
    }
  }
}

/** `undefined` quando removeu; o erro da última tentativa quando não. */
async function attemptRemoval(worktree: WorktreeRef): Promise<unknown> {
  let lastError: unknown;
  for (const delay of REMOVAL_RETRY_DELAYS_MS) {
    await wait(delay);
    try {
      await window.headTerminal.git.removeWorktree({
        path: worktree.path,
        branch: worktree.branch,
        deleteBranch: true,
      });
      logEvent("info", "worktree.removed", { path: worktree.path });
      return undefined;
    } catch (error) {
      lastError = error;
    }
  }
  return lastError ?? new Error("Falha desconhecida ao remover o worktree");
}

/** Junta, sem repetir, as árvores que o app criou para uma sessão e para os
 * terminais dela. */
function collectSessionWorktrees(session: AgentSession): WorktreeRef[] {
  const byPath = new Map<string, WorktreeRef>();
  for (const worktree of [
    ...(session.worktree ? [session.worktree] : []),
    ...collectPaneWorktrees(session.layout),
  ]) {
    byPath.set(worktree.path, worktree);
  }
  return [...byPath.values()];
}

/** Fecha um terminal depois de decidir o que fazer com a árvore que era só dele. */
export async function closePaneWithWorktreeReview(
  paneId: string,
): Promise<void> {
  const session = useSessionStore
    .getState()
    .sessions.find((item) => findPaneNode(item.layout, paneId) !== null);
  if (!session) {
    return;
  }

  // O último terminal de uma sessão não fecha; remover a árvore aqui apagaria a
  // pasta de um pane que continuaria aberto nela.
  const worktree = findPaneNode(session.layout, paneId)?.worktree;
  const worktrees =
    worktree && collectPaneIds(session.layout).length > 1 ? [worktree] : [];

  const decision = await decideWorktreesOnClose(worktrees, {
    label: "Este terminal",
  });
  if (!decision.proceed) {
    return;
  }

  // Fechar primeiro: enquanto o shell vive, a pasta dele não sai do disco.
  useSessionStore.getState().closePane(paneId);
  await removeWorktrees(decision.remove);
}

/** Pergunta antes de fechar: um clique perdido não pode matar uma sessão, e
 * quem tem agent rodando precisa saber que o processo vai junto. */
async function confirmSessionClose(session: AgentSession): Promise<boolean> {
  const { paneRuntime } = useSessionStore.getState();
  const working = getSessionActivity(session, paneRuntime) === "working";
  return confirmInApp({
    title: `Fechar “${session.title}”?`,
    message: working
      ? "Um agent ainda está executando nesta sessão."
      : "Os terminais desta sessão serão encerrados.",
    detail: working
      ? "Fechar encerra o processo e o que ele estava fazendo."
      : undefined,
    confirmLabel: "Fechar sessão",
    cancelLabel: "Cancelar",
    danger: true,
  });
}

/** Fecha a sessão depois de confirmar e de decidir o que fazer com as árvores
 * criadas nela. */
export async function closeSessionWithWorktreeReview(
  sessionId: string,
): Promise<void> {
  const session = useSessionStore
    .getState()
    .sessions.find((item) => item.id === sessionId);
  if (!session) {
    return;
  }

  if (!(await confirmSessionClose(session))) {
    return;
  }

  const decision = await decideWorktreesOnClose(
    collectSessionWorktrees(session),
    { label: `A sessão ${session.title}` },
  );
  if (!decision.proceed) {
    return;
  }

  useSessionStore.getState().removeSession(sessionId);
  await removeWorktrees(decision.remove);
}
