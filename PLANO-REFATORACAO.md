# Plano de Refatoração — Head Terminal

> Brainstorm profundo (julho/2026). Cobre: resiliência do PTY, performance, design
> futurista/clean e informações de execução no menu. Execução planejada em 4 fases.

---

## 0. Diagnóstico — como o app funciona hoje

- **Sessão** = título + cwd + perfil de agent + layout de panes (`types/session.ts`). Cada pane tem um xterm + PTY próprios, criados em `useAgentSession.ts`.
- **Spawn** é lazy: `spawnedSessionIds` só marca a sessão ativa; as demais só montam quando clicadas (`session-manager.ts:270-287`, `AppShell.tsx:114-121`).
- **Atividade** (starting/idle/working/waiting_input/error/exited) é inferida por regex sobre o output (`activity-detector.ts`) e agregada por sessão (`activity-utils.ts`).
- **Persistência** em localStorage com debounce de 400ms (`session-persistence.ts`).
- **Git context** via watcher Rust (`git.rs`) + poll de 8s por sessão (`useGitContext.ts`).
- Visual atual: preto flat + magenta Hyper (`config/theme.ts`, `styles/tokens.css`), botões de texto, glifos improvisados ("⌘", "«", "Split ↓"), CSS monolítico de 1287 linhas (`styles/global.css`) com blocos duplicados e classes mortas.

---

## 1. O mistério do "terminal encerra e volta sozinho"

Três causas reais, todas identificadas no código:

### 1.1 Fallback silencioso do shell (a causa mais provável)
`src/config/agents.ts:10-24` — todo perfil spawna:

```
zsh -l -c 'cursor agent; exec zsh -l'
```

Quando o **agent morre** (crash, `/exit`, update do CLI), o `exec zsh -l` substitui o
processo **no mesmo PTY**. Para o usuário: a TUI do agent some, a tela limpa e um shell
"volta sozinho". **Nenhum evento de exit dispara** (o PTY nunca morreu), então a UI não
tem como saber que o agent caiu — hoje isso é 100% invisível para o app.

### 1.2 Restart implícito por dependência de efeito
`useAgentSession.ts:312-327` — o efeito que cria terminal + PTY depende de
`cwd`, `agentProfileId`, `restartKey`, `continueConversation`. Qualquer mudança roda o
cleanup (`bridge.dispose()` → `pty.kill()` + `terminal.dispose()`) e respawna tudo.
`updateSessionCwd`/`updateSessionAgent` (`session-manager.ts:306-340`) chamam
`restartSessionPanes` — ou seja, **um blur no input de cwd da sidebar com valor
alterado mata todos os panes da sessão** sem aviso.

### 1.3 Não existe auto-restart de verdade
Quando o PTY morre, só aparece o overlay "Processo encerrado" com botão manual
(`TerminalPaneChrome.tsx:32-49`). Nada tenta reconectar.

**Agravante**: qualquer restart destrói o xterm inteiro (`terminal.dispose()` no
cleanup), perdendo todo o scrollback — daí o "flash" visual.

---

## 2. Resiliência — proposta

### 2.1 Separar ciclo de vida: terminal ≠ processo
Quebrar `useAgentSession.ts` em dois hooks:

- **`useTerminalInstance(containerRef, paneId)`** — cria o xterm **uma vez** por pane,
  registra fit/focus/composition-guard, e só faz dispose quando o pane sai do layout.
- **`usePtyProcess(terminal, { profile, cwd, restartKey })`** — spawn, listeners de
  data/exit, kill. Um restart mata só o PTY; o scrollback sobrevive e o hook escreve um
  separador no buffer:

```
── sessão reiniciada (tentativa 2) ─────────────────
```

Arquivos: `src/hooks/useAgentSession.ts` (split), `src/hooks/useTerminalInstance.ts`
(novo), `src/hooks/usePtyProcess.ts` (novo).

### 2.2 Supervisor com backoff exponencial (`src/core/pane-supervisor.ts`, novo)
Máquina de estados por pane:

```
healthy → exited → countdown(delay) → respawning → healthy
                                    ↘ (N tentativas) → failed (manual)
```

- Backoff: 0.5s → 1s → 2s → 4s → 8s (cap). Contador zera após 60s saudável.
- Máximo 5 tentativas → estado `failed` com botão "Reiniciar" manual.
- Overlay **não bloqueante** com countdown: "Reconectando em 4s (tentativa 2/5)" +
  botões "Agora" e "Cancelar".
- Saída intencional não respawna: `closePane` e "Cancelar" marcam o pane como
  `user_stopped`.
- Wire-up: no callback de `attachPtyExitListener` (`useAgentSession.ts:243-252`),
  consultar o supervisor em vez de só marcar `exited`. O supervisor agenda
  `restartPane` (já existe em `session-manager.ts:422-462`).
- Testes: `pane-supervisor.test.ts` (backoff, cap, reset, cancelamento) — segue o
  padrão dos testes existentes de `activity-detector.test.ts`.

### 2.3 Sentinela OSC — tornar o fallback do shell visível
Mudar os args do perfil (`agents.ts`) para emitir uma sequência OSC privada quando o
agent morrer, antes do fallback:

```
zsh -l -c 'cursor agent; printf "\x1b]7770;agent-exited:%s\x07" $?; exec zsh -l'
```

No frontend, registrar handler no parser do xterm (em `usePtyProcess`):

```ts
terminal.parser.registerOscHandler(7770, (payload) => {
  const exitCode = Number(payload.split(":")[1] ?? "0");
  onAgentFallback(exitCode); // → atividade "agent_fallback"
  return true;
});
```

- Novo estado `agent_fallback` em `types/activity.ts` (cor laranja, label
  "Agent caiu — shell ativo") com prioridade entre `error` e `working`.
- UI oferece "Reiniciar agent" no header do pane — que roda `restartPane` (ou envia
  `cursor agent --continue\n` pelo ptyWriter, sem matar o shell).
- Isso **explica e domestica** o comportamento estranho atual: o fallback continua
  existindo (é bom — o pane nunca fica morto), mas passa a ser visível e acionável.

### 2.4 Higiene
- `updateSessionCwd`/`updateSessionAgent`: confirmar antes de reiniciar ("Alterar a
  pasta reinicia os terminais da sessão. Continuar?") ou aplicar só em novos panes.
- Desregistrar `ptyWriters` no exit (hoje comandos da toolbar são engolidos por PTYs
  mortos até o respawn).

---

## 3. Performance

### 3.1 Store: parar de reescrever `sessions` em mudança de status ⭐ (maior bug invisível)
`updatePaneStatus` (`session-manager.ts:650-672`) recria o array `sessions` a cada
transição de status. Consequência em cascata:

1. `App` re-renderiza (assina `state.sessions`).
2. `useGitContextWatchers` tem `sessions` no array de deps (`useGitContext.ts:106`) →
   **derruba e recria todos os watchers Rust, refaz `fetchGitContext` de todas as
   sessões e reinstala os intervals de 8s** a cada status flip de qualquer pane.

**Fix**: consolidar estado volátil em um índice fora de `sessions`:

```ts
paneRuntime: Record<string, {
  status: SessionStatus;
  activity: PaneActivity;
  activitySince: number;   // p/ "executando há 2m" na sidebar
  lastOutputAt: number;    // throttled a 1s
  restartAttempts: number; // p/ supervisor (§2.2)
}>
```

`sessions` só muda em criar/remover/renomear/layout. `paneStatuses` sai de
`AgentSession` (ou vira derivado só na persistência). `useGitContextWatchers` passa a
depender de projeção estável (`sessions.map(s => s.id + s.cwd).join()`).

### 3.2 Detectores por chunk → por frame
`ActivityDetector.onData` roda ~18 regexes sobre até 2KB **a cada chunk**
(`activity-detector.ts:42-51`); `WorkspaceDetector` roda mais 6 regexes e decodifica o
chunk **de novo** (`workspace-detector.ts:21-38` — decode duplicado, ver
`useAgentSession.ts:239-241`). Com agent despejando output, são centenas de execuções
por segundo na main thread.

**Fix**: o batching por rAF já existe para o `terminal.write`
(`terminal-factory.ts:70-116`). Estender `createRafPtyWriter` para, no flush do frame,
decodificar o texto concatenado **uma vez** e alimentar os dois detectores 1×/frame.
Adicionar pré-checagens baratas antes das regexes (`text.includes("\x1b")`,
`indexOf` dos chars de spinner).

### 3.3 Seletores estreitos na sidebar/toolbar
`SessionListItem` assina os records inteiros `paneActivities`, `paneGitContext`,
`sessionGitContext` (`SessionSidebar.tsx:58-62`) → todo tick de atividade re-renderiza
**todos** os itens, e cada render chama `buildAgentProfiles()` (linha 76) e
`pickGitContextForSession`.

**Fix**: seletores derivados por sessão com `useShallow` (zustand v5), hoist dos
profiles para constante de módulo, memoizar o agregado de atividade por sessão.

### 3.4 Renderer do terminal (maior ganho bruto potencial)
WebGL está desligado para **todo** Linux por user-agent (`terminal-factory.ts:57-60`) →
DOM renderer, o mais lento do xterm. Mas o Rust já força
`WEBKIT_DISABLE_DMABUF_RENDERER=1` (`lib.rs:26-30`), que era a causa do black screen.

**Fix**: preferência `renderer: auto | webgl | dom` em `ui-preferences.ts` +
`SettingsDialog`. Em `auto`, tentar WebGL com guarda dupla: `onContextLoss` (já
existe) + verificação de primeiro frame pintado (se falhar, gravar flag e cair para
DOM permanentemente). Ganho grande em scroll/throughput se o WebGL funcionar com
DMABUF desligado.

### 3.5 Git: dedupe por repoRoot + polling adaptativo
Hoje: 1 watcher + 1 poll de 8s **por sessão** (`useGitContext.ts:17, 75-84`) e mais 1
watcher **por pane** (`useAgentSession.ts:82-90`). Várias sessões no mesmo repo =
trabalho duplicado.

**Fix**: registry central por `repoRoot` (novo `src/core/git-context-registry.ts`):
um watcher + um poll por repo, com refcount; sessões/panes assinam o registry.
Pausar poll quando `document.hidden`; alongar para 30s sem foco.

### 3.6 Miudezas
- `loadPaneHeadersEnabled()` lê localStorage a cada render (`TerminalPane.tsx:40`) →
  cache em módulo.
- `useActivityNotifications` (`useAppShortcuts.ts:8-23`) itera todas as sessões a cada
  mudança de atividade → mover para `useSessionStore.subscribe` com debounce.
- CSS: `global.css` tem blocos duplicados (`.terminal-overlay` 2× em 1112-1148 e
  1150-1194; `.command-palette` 2× em 940-1103 e 1212-1287) e classes mortas sem
  componente (`.session-context-menu`, `.session-sidebar__working-badge`,
  `.session-sidebar__pin`, `.status-badge` — o componente `StatusBadge.tsx` existe mas
  nunca é importado). Limpar na reorganização (§4.7).

---

## 4. Design — futurista, clean

### 4.1 Fundação: expandir `styles/tokens.css`
Sair do preto flat para fundo em camadas + segunda cor de acento:

```css
:root {
  /* Superfícies em camadas (profundidade) */
  --bg-0: #050507;   /* janela */
  --bg-1: #0a0a10;   /* sidebar */
  --bg-2: #10101a;   /* toolbar, cards */
  --bg-3: #171724;   /* hover / elevated */

  /* Identidade: magenta Hyper mantida + cyan elétrico */
  --accent: #f81ce5;
  --accent-2: #22d3ee;
  --gradient-brand: linear-gradient(135deg, var(--accent), var(--accent-2));

  /* Glow para elementos ativos (usar com moderação) */
  --glow-accent: 0 0 12px rgba(248, 28, 229, 0.35);
  --glow-working: 0 0 8px rgba(103, 248, 111, 0.4);

  /* Escalas */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --radius-sm: 6px; --radius-md: 10px; --radius-lg: 14px;
  --font-xs: 11px; --font-sm: 12px; --font-md: 13px; --font-lg: 15px;
  --z-divider: 2; --z-overlay: 3; --z-tooltip: 20; --z-menu: 50; --z-modal: 100;

  /* Focus ring consistente */
  --focus-ring: 0 0 0 2px rgba(34, 211, 238, 0.4);
}
```

O terminal em si continua `#000` puro (contraste máximo); o chrome ao redor ganha
profundidade. Manter o magenta como assinatura, cyan para interativos/focus.

### 4.2 Ícones — adotar `lucide-react`
MIT, tree-shakeable (~1KB por ícone). Substituir os glifos de texto:

| Hoje | Onde | Novo ícone |
|------|------|-----------|
| `⌘` | `AgentToolbar.tsx:109` | `Command` |
| `«` / `»` | `SessionSidebar.tsx:321` | `PanelLeftClose` / `PanelLeftOpen` |
| `Split ↓` / `Split →` | `AgentToolbar.tsx:119,129` | `SquareSplitVertical` / `SquareSplitHorizontal` |
| `+ Nova` / `+` | `SessionSidebar.tsx:310,354` | `Plus` |
| — | branch badge | `GitBranch` |
| — | settings | `Settings2` |
| — | status "executando" | `Activity` / `Loader` |

Manter `Icons.tsx` como barrel que re-exporta lucide (troca fácil depois).

### 4.3 Toolbar (`AgentToolbar.tsx` + CSS)
Três zonas com hierarquia clara:

```
[● HeadTerminal   (2 executando)] | [Clear] [Compact] [Context] [Help] | [Run all] [split][split] [⌘] [⚙]
 brand + status global              comandos do agent (ícone+label)      layout / paleta / settings
```

- Altura 44px, fundo `linear-gradient(180deg, var(--bg-2), var(--bg-1))`, borda
  inferior 1px `--border-subtle`.
- Botões ghost com ícone + label; hover eleva para `--bg-3` com transição 120ms;
  botão primário (Clear) com borda accent sutil.
- Pill de status global usando `countWorkingSessions` (**já existe** em
  `activity-utils.ts:55-62`, nunca foi usado): StatusDot pulsante + "2 executando".

### 4.4 Sidebar como centro de informação de execução
Redesenhar o card de sessão (`SessionListItem`):

```
┌──────────────────────────────┐
│ ● Sessão hold-backend   [CL] │  ← LED pulsante + título + chip do agent
│  main* · ~/D…/hold-backend   │  ← branch + dirty + cwd encurtado
│  ▪▪▫  executando há 2m       │  ← 1 dot por pane (cor=atividade) + tempo
└──────────────────────────────┘
```

- **Dots por pane**: um quadradinho por terminal, cor pela atividade, clicável →
  ativa a sessão E foca aquele pane. Tooltip com label ("Terminal 2 — Aguardando").
- **Tempo no estado**: "executando há 2m" via `paneRuntime.activitySince` (§3.1) +
  ticker de 1s ativo só com sidebar expandida e janela focada.
- **Chip do agent**: "CL" (Claude), "CU" (Cursor), "CX" (Codex), "SH" (Shell) com
  cor própria — identifica o perfil sem abrir o select.
- **Rail colapsado**: chip da inicial com **anel de status** (border 2px na cor da
  atividade, pulse quando working) + contador de working no topo do rail.
- **Header**: renderizar o badge agregado (`.session-sidebar__working-badge` já
  existe no CSS, `global.css:380-392`, nunca foi renderizado).
- **Context menu** (clique direito): Renomear, Fixar, Duplicar, Fechar — o CSS
  (`.session-context-menu`, `global.css:654-683`) e as actions do store
  (`togglePinSession`, `session-manager.ts:408-420`) **já existem sem UI**.
- **Drag reorder**: `reorderSessions` também já existe no store (`:387-406`) sem UI —
  implementar com HTML5 drag ou pointer events.
- Settings inline do card (select de agent + input de cwd) saem do card e viram um
  popover acionado por ícone de engrenagem — hoje qualquer clique acidental no input
  de cwd pode reiniciar a sessão (§2.4).

### 4.5 Overlays e estados vazios
- Unificar os dois `.terminal-overlay` duplicados num componente estilizado: painel
  central com `backdrop-filter: blur(8px)` (fallback sólido `rgba(5,5,7,.85)` se
  WebKitGTK sofrer), ícone, título, descrição e ações.
- Overlay de reconexão do supervisor (§2.2) com countdown circular ou barra.
- BootScreen: wordmark com `--gradient-brand` + barra de progresso fina cyan→magenta.

### 4.6 Motion
- Tudo entre 120–160ms, só `opacity`/`transform` (nunca propriedades de layout perto
  do terminal — reflow do xterm é caro).
- `@media (prefers-reduced-motion: reduce)` desliga pulses e slides.
- Pulse do LED working já existe (`animations.css:1-12`) — manter, é barato.

### 4.7 Organização do CSS
Quebrar `global.css` (1287 linhas) em módulos importados:

```
styles/
├── tokens.css        (expandido, §4.1)
├── base.css          (reset, root, boot screen)
├── toolbar.css
├── sidebar.css
├── panes.css         (pane, header, overlay, dividers, status bar)
├── dialogs.css       (palette, create, settings)
└── animations.css
```

Na migração, remover os blocos duplicados e classes mortas (§3.6).

---

## 5. Informações de execução no menu (consolidado)

| Onde | O quê | Fonte |
|------|-------|-------|
| Card da sessão | dots por pane + label + tempo no estado | `paneRuntime` (§3.1) |
| Header da sidebar | "N executando" agregado | `countWorkingSessions` (existe) |
| Rail colapsado | anel de status + badge de working | idem |
| Toolbar | pill global com contagem | idem |
| Título da janela | "● 2 executando — Head Terminal" via `getCurrentWindow().setTitle()` | novo efeito em `AppShell` |
| Notificação desktop | waiting_input/erro em sessão não focada | `notifications.ts` (existe, polir dedup por transição) |
| Pane header | estado + "última atividade há Xs" | `paneRuntime.lastOutputAt` |
| Novo estado | `agent_fallback` (laranja) — agent caiu, shell ativo | sentinela OSC (§2.3) |

---

## 6. Fases de execução

**Fase 1 — Fundação de performance** (sem mudança visual, baixo risco)
§3.1 paneRuntime + fim da reescrita de sessions → §3.3 seletores → §3.2 detectores
por frame → §3.5 git registry → §3.6 miudezas. Testes existentes cobrem detectores e
layout; adicionar teste do registry.

**Fase 2 — Resiliência**
§2.1 split terminal/PTY → §2.2 supervisor + backoff + overlay de reconexão →
§2.3 sentinela OSC + estado `agent_fallback` → §2.4 confirmações.
Depende da Fase 1 (paneRuntime guarda restartAttempts).

**Fase 3 — Design system**
§4.1 tokens → §4.7 split do CSS (limpando duplicados) → §4.2 ícones → §4.3 toolbar →
§4.4 sidebar → §4.5 overlays. Componente a componente, cada PR compila sozinho.

**Fase 4 — Execução visível + extras**
§5 (dots, tempos, título da janela) → §3.4 setting de renderer + experimento WebGL →
context menu + pin + drag reorder.

---

## Apêndice — inventário de código pronto mas desligado

| Item | Onde | Falta |
|------|------|-------|
| `countWorkingSessions` | `activity-utils.ts:55` | renderizar (§4.3, §4.4) |
| `togglePinSession` | `session-manager.ts:408` | UI (context menu) |
| `reorderSessions` | `session-manager.ts:387` | UI (drag) |
| `StatusBadge` | `components/ui/StatusBadge.tsx` | nunca importado |
| `.session-context-menu` | `global.css:654` | componente |
| `.session-sidebar__working-badge` | `global.css:380` | renderizar |
| `.session-sidebar__pin` | `global.css:517` | UI de pin |
