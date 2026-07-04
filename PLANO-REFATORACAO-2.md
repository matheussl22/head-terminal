# Plano de Refatoração 2 — Head Terminal (Rodada 2)

> Continuação do `PLANO-REFATORACAO.md`. A rodada 1 cobre fundação (performance,
> resiliência, design system, info de execução). Esta rodada 2 adiciona
> **funcionalidades novas essenciais**, aprofunda pontos da rodada 1 e fecha lacunas
> de segurança/infra descobertas na segunda varredura do código.
>
> Convenções: **P0** = essencial, sem isso o app irrita no dia a dia · **P1** = alto
> valor · **P2** = bom ter. Esforço: **S** (<meio dia) · **M** (1-2 dias) · **L** (3+).

---

## 1. Essenciais de terminal que ainda não existem (P0)

São capacidades que qualquer terminal maduro tem e cuja ausência se sente em minutos
de uso. Todas são pequenas e independentes entre si.

### 1.1 Busca no scrollback (Ctrl+F) — P0/S
Não há como procurar nada no output de um agent que rodou por 20 minutos.

- Dependência: `@xterm/addon-search` (compatível com xterm 6).
- Carregar em `createConfiguredTerminal()` (`terminal-factory.ts:13-55`) e expor o
  handle num registry por pane — replicar o padrão de `pane-fit-registry.ts`
  (novo `src/core/terminal-registry.ts` guardando `{ terminal, searchAddon }`;
  de quebra, isso serve o zoom de fonte do §1.2).
- UI: barra flutuante no topo do pane ativo (`components/terminal/SearchBar.tsx`,
  novo): input + contador "3/17" + setas + fechar. `findNext/findPrevious` com
  `decorations` (highlight de todas as ocorrências).
- Atalho `Ctrl+F` em `useAppShortcuts.ts` (só quando um pane tem foco); `Esc` fecha
  e devolve o foco ao terminal.

### 1.2 Zoom de fonte (Ctrl+= / Ctrl+- / Ctrl+0) — P0/S
Tamanho fixo em 12px (`config/theme.ts:7`). Em monitor 4K é ilegível.

- Preferência `fontSize` em `ui-preferences.ts` (novo par load/save, clamp 8-24).
- Aplicação global: iterar o `terminal-registry` (§1.1) fazendo
  `terminal.options.fontSize = n` + `fitPanes(...)` — o resize do PTY já acontece
  em cadeia via `terminal.onResize` (`useAgentSession.ts:256-260`).
- Atalhos em `useAppShortcuts.ts`; item "Aumentar/diminuir fonte" na paleta.

### 1.3 Clipboard decente — P0/S
Hoje só funciona o que o WebKitGTK dá de graça.

- `Ctrl+Shift+C` copia seleção / `Ctrl+Shift+V` cola, via
  `attachCustomKeyEventHandler` no `terminal-factory.ts` (já existe um handler para
  F9 na linha 30 — estender em vez de sobrescrever).
- Preferência "copy on select" (padrão de quem vive em terminal).
- Menu de contexto do pane (clique direito): Copiar / Colar / Limpar / Buscar /
  Exportar output (§3.4) — reutiliza o padrão visual do context menu de sessão
  (rodada 1, §4.4).

### 1.4 Confirmação ao fechar com agent executando — P0/S
Fechar a janela hoje mata todos os PTYs sem aviso (`lib.rs:80-82` só loga
`close_requested`).

- No frontend: `getCurrentWindow().onCloseRequested` em `AppShell`; se algum pane
  está `working` (consultar `paneRuntime`, rodada 1 §3.1), `event.preventDefault()`
  + dialog "2 agents ainda executando. Fechar mesmo assim?".
- Bônus: flush síncrono da persistência antes de fechar
  (`flushPersistedWorkspace`, `session-persistence.ts:121-124`).

### 1.5 Segunda instância deve focar a janela, não morrer em silêncio — P0/S
`acquire_instance_lock` (`startup.rs:124-159`) faz a segunda invocação dar
`exit(0)` sem nenhum feedback (`lib.rs:34-44`) — pra quem clicou no dock, o app
"não abriu".

- Trocar o lock manual por `tauri-plugin-single-instance`: o callback roda na
  instância viva → `window.unminimize() + set_focus()`.
- Remover `acquire_instance_lock`/`InstanceLock` do `startup.rs` (menos código
  custom para manter).

### 1.6 Seletor de pasta nativo + recentes na criação de sessão — P0/S
`CreateSessionDialog` exige digitar o path na mão; um typo cria sessão num cwd
inválido e o spawn falha.

- `tauri-plugin-dialog` para "Procurar…" (directory picker nativo).
- MRU de cwds usados (últimos 8) em `ui-preferences.ts`, renderizados como chips
  clicáveis no dialog.
- Validar existência do diretório antes de criar (novo cmd Rust `path_exists` ou
  `tauri-plugin-fs`); erro inline no dialog em vez de pane quebrado.
- Título default vira `basename(cwd)` em vez de "Sessão N"
  (`App.tsx:107-118` — `createInitialSession` já faz isso quando `title` é
  omitido; hoje o dialog passa "Sessão N" por cima).

### 1.7 Detectar CLIs de agent instaladas — P0/S
Se `cursor`/`claude`/`codex` não estão no PATH, o perfil cai para shell puro sem
explicação (o `zsh -c` falha o comando e executa o fallback — invisível, mesmo
problema da rodada 1 §1.1).

- Novo cmd Rust `check_agent_clis`: roda `zsh -lc 'command -v cursor claude codex'`
  (login shell para pegar o PATH real do usuário).
- Cache no boot; `CreateSessionDialog` e `SessionSidebar` marcam perfis
  indisponíveis ("Codex CLI — não instalada") em vez de deixar selecionar.
- Aproveita e elimina a heurística cega em `SettingsDialog.tsx:28`
  (`AGENTS_WITH_MCP_SUPPORT` hardcoded).

---

## 2. Produtividade com agents (P1)

### 2.1 Biblioteca de prompts/snippets do usuário — P1/M ⭐
Os 4 comandos da toolbar são hardcoded (`config/toolbar.ts:14-40`). O fluxo real com
agents é repetir prompts longos ("roda os testes e corrige", "faz review do diff…").

- Novo `src/core/snippets.ts`: CRUD de snippets persistidos
  (`{ id, label, text, favorite, scope: "global" | repoRoot }`).
- Variáveis interpoladas na hora do envio: `{{cwd}}`, `{{branch}}` (via
  `paneGitContext`), `{{clipboard}}`.
- UI: aba "Snippets" no `SettingsDialog`; favoritos aparecem na toolbar ao lado dos
  comandos fixos; todos entram na paleta com prefixo ("Snippet: …").
- Envio usa `sendAgentCommand` (`actions/sendAgentCommand.ts:11-19`) — já respeita
  o "Run all".

### 2.2 Paleta de comandos v2 — P1/M
Hoje a paleta é uma lista estática com filtro por substring
(`CommandPalette.tsx:29-41`).

- **Seções**: Sessões ("Ir para: hold-backend" — troca de sessão por fuzzy),
  Snippets (§2.1), Ações, Recentes (últimas N ações executadas).
- Fuzzy score simples (subsequência com bônus de início de palavra) — sem
  dependência nova.
- Mostrar atalhos à direita (já existe) + ícones por tipo (design da rodada 1 §4.2).

### 2.3 Aprovação rápida quando o agent pergunta — P1/M ⭐
O `ActivityDetector` já reconhece "Waiting for approval" e `(y/n)`
(`activity-detector.ts:11,27`) mas a informação só vira um label.

- Estender o detector para classificar o tipo de prompt em
  `paneRuntime.pendingPrompt: "yes_no" | "approval" | "generic" | null`.
- Barra de ação inline no pane em `waiting_input`: `[Aprovar ⏎] [y] [n]` — botões
  que fazem `sendTextToPane(paneId, "y\r")` etc. (`sendAgentCommand.ts:21-24`).
- Na sidebar, sessão com prompt pendente ganha destaque âmbar pulsante (conecta com
  os dots por pane da rodada 1 §4.4).
- Na notificação desktop (`notifications.ts`), ação de clicar → foca a sessão
  (hoje a notificação é inerte).

### 2.4 Zoom/maximizar pane — P1/S
Com 3-4 splits, ler o output de um deles é apertado.

- `zoomedPaneId: string | null` no store; quando setado, `SessionWorkspace` renderiza
  só aquele pane em 100% (os outros ficam montados/ocultos — PTYs intactos, mesmo
  mecanismo de `session-workspace--hidden`).
- Toggle: duplo clique no header do pane ou `Ctrl+Shift+Z`; sair do zoom refaz
  `fitPanes`.

### 2.5 Input sincronizado (broadcast de digitação) — P1/S
"Run all" replica só comandos da toolbar. Falta digitar uma vez e mandar para todos
os panes da sessão (ex.: mesmo prompt para Claude e Cursor lado a lado, comparar).

- Toggle por sessão `syncInput`; quando ativo, o `terminal.onData` do pane focado
  (`useAgentSession.ts:253-255`) replica o data para os `ptyWriters` dos demais
  panes da sessão. `onData` é só input do usuário, então é seguro replicar.
- Indicador visual forte (borda cyan nos panes espelhados) para não esquecer ligado.

### 2.6 Abrir arquivos citados no editor — P1/M
O agent cita paths o tempo todo; hoje só URLs são clicáveis (`WebLinksAddon`,
`terminal-factory.ts:22`).

- `terminal.registerLinkProvider` com regex de path (+`:linha` opcional) sobre a
  linha do hover — o `WorkspaceDetector` (`workspace-detector.ts:5-12`) já tem os
  padrões de path; extrair para módulo comum.
- Clique → cmd Rust `open_in_editor(path, line)`: spawna o editor configurado
  (`cursor -g {path}:{line}` / `code -g` / fallback `xdg-open`), preferência no
  Settings.
- Resolver paths relativos contra `paneGitContext.repoRoot ?? session.cwd`.

### 2.7 Drag & drop de arquivos no terminal — P1/S
- `getCurrentWebview().onDragDropEvent` no `AppShell`: soltar arquivo sobre um pane
  → `sendTextToPane(paneId, shellQuote(path))` (com espaço no fim). Multi-arquivo =
  paths separados por espaço.
- Overlay visual "solte para inserir o caminho" durante o drag (reusa o padrão de
  overlay da rodada 1 §4.5).

---

## 3. Continuidade e memória (P1)

### 3.1 Persistência de scrollback entre restarts — P1/L ⭐
O `--continue` (rodada 1 / `agents.ts:10-17`) recupera a conversa do agent, mas a
tela volta vazia — o contexto visual se perde a cada reinício do app.

- Dependência: `@xterm/addon-serialize`.
- Snapshot do buffer (últimas ~2000 linhas) por pane: debounced (a cada 10s se houve
  output) + flush no `onCloseRequested` (§1.4).
- Armazenar em arquivo por pane no app data dir (**não** localStorage — tamanho),
  via `tauri-plugin-fs`: `~/.local/share/head-terminal/scrollback/<paneId>.bin`.
- No restore (`useAgentSession` bootstrap): `terminal.write(snapshot)` + separador
  "── sessão restaurada ──" **antes** do spawn do PTY.
- GC: apagar arquivos de panes que não existem mais no workspace persistido.
- Pré-requisito: split terminal/PTY da rodada 1 §2.1 (o snapshot pertence ao
  terminal, não ao processo).

### 3.2 Workspace em arquivo, não em localStorage — P1/M
`session-persistence.ts:5-13` usa localStorage: limpa os dados do WebKitGTK e o
workspace inteiro evapora; também não dá para versionar/backupar.

- Trocar o backend de `savePersistedWorkspace`/`loadPersistedWorkspace` por arquivo
  JSON no app data dir (mesma interface pública — mudança contida num arquivo).
- Migração transparente: se o arquivo não existe mas o localStorage tem dados,
  importar e regravar.
- Backup rotativo simples (`workspace.json.1`) contra corrupção em crash no meio
  do write (write em temp + rename atômico).
- Ações na paleta: "Exportar workspace…" / "Importar workspace…".

### 3.3 Templates de workspace — P1/M ⭐
Todo dia a mesma coreografia: criar sessão do backend, do frontend, do infra…

- `src/core/workspace-templates.ts`: template = lista de
  `{ title, cwd, agentProfileId, layout? }` + nome.
- "Salvar workspace atual como template" (paleta) — serializa as sessões vivas.
- "Abrir template: <nome>" (paleta e dialog de criação) — cria todas as sessões de
  uma vez (`addSession` em sequência; spawn continua lazy, só a ativa sobe na hora,
  o que mantém o boot leve).
- Persistência junto ao workspace (§3.2).

### 3.4 Exportar transcript da sessão — P2/S
Compartilhar o que o agent fez sem screenshot.

- Ação no context menu do pane / paleta: serializa o buffer (mesmo addon do §3.1)
  → save dialog → `.txt` (ANSI stripped) ou `.ansi` (cru).
- Strip de ANSI já tem base no `workspace-detector.ts:14-16` — extrair util comum.

---

## 4. Sinal de execução de alta fidelidade (P1) ⭐

**A melhoria mais estrutural desta rodada.** Todo o sistema de atividade da rodada 1
depende de regex sobre output (`activity-detector.ts`), que é heurístico e frágil.
Existe um padrão da indústria que dá o sinal exato: **shell integration via OSC 133**
(usado por VS Code, WezTerm, Kitty).

### 4.1 OSC 133 para panes de shell
- Criar `src-tauri/resources/shell-integration.zsh`: hooks `precmd`/`preexec` que
  emitem `OSC 133;A` (prompt), `OSC 133;C` (comando começou),
  `OSC 133;D;<exit_code>` (comando terminou).
- Injetar no spawn: `zsh -l` vira
  `zsh -l -c 'source <integration>; exec zsh -l'` ou via `ZDOTDIR` sombreado
  (abordagem do VS Code — não polui o rc do usuário).
- No frontend: `terminal.parser.registerOscHandler(133, …)` (mesmo mecanismo da
  sentinela 7770 da rodada 1 §2.3) → estados **exatos**: rodando / terminou com
  código N / no prompt.
- `ActivityDetector` vira **fallback** para quando não há marcas OSC (TUIs de
  agent), com precedência: OSC > regex.

### 4.2 Consequências no produto
- Sidebar/menu mostram "✔ terminou (0) há 30s" ou "✘ falhou (1)" com precisão de
  código de saída — sem adivinhação.
- O supervisor (rodada 1 §2.2) distingue "shell no prompt" (saudável, não reinicia)
  de "processo morto" (reinicia).
- Duração real de cada comando (C→D) alimenta métricas (§6.3) e o "executando há
  Xm" da sidebar sem heurística de idle-timeout.

---

## 5. Integração com o sistema (P1/P2)

### 5.1 Central de notificações interna — P1/M
`notifications.ts` dispara notificação desktop e esquece; `clearSessionNotification`
nunca é chamado (dedup por `notifiedKeys` só cresce).

- Ring buffer de eventos no store (`attentionLog`, máx 50): transições para
  `waiting_input`, `error`, `agent_fallback`, restarts do supervisor.
- Ícone de sino na toolbar com badge; painel dropdown lista eventos; clique → foca
  sessão/pane (via `setActiveSessionId`/`setActivePaneId`).
- Corrigir o dedup: limpar a chave quando a atividade sai do estado de atenção
  (subscribe no store, rodada 1 §3.6).

### 5.2 Tray icon com contagem — P2/M
- `tauri::tray` com badge/tooltip "2 executando" (dado do `countWorkingSessions`);
  menu: mostrar/ocultar janela, sair. `libayatana-appindicator` já é pré-requisito
  do projeto (README).
- Minimizar para tray como preferência — agents seguem rodando com a janela fechada
  (hoje fechar a janela mata tudo).

### 5.3 Voice v2 — P2/M
Infra atual: F9 toggle, Whisper via OpenAI (`voice-input.ts`, `voice.rs`).

- **Push-to-talk**: segurar F9 grava, soltar transcreve (keydown/keyup em
  `useAppShortcuts.ts:55-62`) — menos estado mental que toggle.
- Indicador de nível de áudio no botão do mic durante gravação (analyser no stream
  que o Rust já captura → evento Tauri com RMS, ou simplificar com animação).
- Preferência de idioma da transcrição (hoje implícito) e de auto-envio
  (transcrever + `\r` direto vs. só inserir para revisar).

### 5.4 Status MCP fora do Settings — P2/S
`get_mcp_servers` (`mcp.rs:55`) só é consultado abrindo o Settings.

- Chip discreto no card da sessão quando algum MCP server do agent daquela sessão
  está com erro ("MCP ✘ 1"); tooltip com detalhe. Cache de 5 min, refresh lazy.

---

## 6. Infra, segurança e saúde do projeto

### 6.1 Chave da API fora do localStorage — P0/M (segurança)
`saveOpenAiApiKey` grava a chave **em texto puro no localStorage**
(`ui-preferences.ts:31-36`) — legível por qualquer processo com acesso ao perfil do
WebKitGTK.

- Mover para o keyring do SO: crate `keyring` (Secret Service no Linux, Keychain no
  macOS) com cmds Rust `secret_get/secret_set`.
- Migração: se existe no localStorage, mover para o keyring e apagar de lá.
- `SettingsDialog` passa a mostrar só "configurada ✔ / não configurada".

### 6.2 Endurecer o CSP — P1/S
`tauri.conf.json` hoje permite `'unsafe-eval'`, `http:`, `https:`, `ws:` de qualquer
origem — além de ter um typo (`img-src:` dentro de `default-src`).

- Reescrever: `default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src
  ipc: http://ipc.localhost` (+ ajustes que o dev server exigir via
  `tauri.dev.conf.json`). A transcrição de voz sai pelo Rust (`voice.rs`), então o
  frontend não precisa de rede externa.

### 6.3 Métricas de uso local — P2/M
Com OSC 133 (§4) e `paneRuntime` (rodada 1), dá para acumular sem custo:

- Tempo em `working` por sessão/dia, comandos executados, restarts do supervisor.
- Persistir em JSON no app data dir; visão simples no Settings ("hoje: 3h12 de
  execução, 2 quedas de agent"). Zero telemetria externa.

### 6.4 Auto-update + CI de release — P2/L
Hoje a distribuição é `deb` manual (`tauri.conf.json` bundle.targets).

- Adicionar target AppImage + `tauri-plugin-updater` (assinatura + endpoint em
  GitHub Releases).
- Workflow GitHub Actions: build deb/AppImage no tag push, publicar release.
- `scripts/head-terminal-release.sh` vira só um atalho local.

### 6.5 Dívidas herdadas da rodada 1 (não repetidas aqui)
CSS duplicado/morto, seletores largos, detectores por chunk, watchers git churn —
ver `PLANO-REFATORACAO.md` §3. Esta rodada **assume a Fase 1 e 2 concluídas**.

---

## 7. Roadmap consolidado (continuando as fases 1-4 da rodada 1)

**Fase 5 — Essenciais de terminal** (tudo P0/S, uma semana confortável)
§1.1 busca → §1.2 zoom → §1.3 clipboard → §1.4 confirmação de saída → §1.5 single
instance → §1.6 picker+recentes → §1.7 detecção de CLIs → §6.1 keyring → §6.2 CSP.

**Fase 6 — Sinal de execução de alta fidelidade**
§4 OSC 133 (integra com supervisor e sidebar da rodada 1) → §2.3 aprovação rápida →
§5.1 central de notificações.

**Fase 7 — Produtividade**
§2.1 snippets → §2.2 paleta v2 → §2.4 zoom de pane → §2.5 input sincronizado →
§2.6 abrir no editor → §2.7 drag & drop.

**Fase 8 — Continuidade e polimento**
§3.2 workspace em arquivo → §3.1 scrollback persistente → §3.3 templates →
§3.4 export → §5.2 tray → §5.3 voice v2 → §6.3 métricas → §6.4 updater.

### Dependências entre rodadas
```
Rodada 1 Fase 1 (paneRuntime) ──► §2.3, §4, §5.1, §6.3
Rodada 1 Fase 2 (split terminal/PTY, OSC 7770) ──► §3.1, §4.1
Rodada 1 Fase 3 (design system) ──► §2.2, §5.1 (visual)
§1.1 (terminal-registry) ──► §1.2, §3.1, §3.4
§3.2 (workspace em arquivo) ──► §3.3
```

---

## 8. Resumo executivo — o que muda para o usuário

| Antes | Depois |
|-------|--------|
| Output do agent é irrecuperável (sem busca) | Ctrl+F com highlight |
| Fonte fixa 12px | Zoom por atalho, persistido |
| Fechar janela mata 3 agents sem aviso | Confirmação + opção de tray |
| Segundo clique no dock não faz nada | Foca a janela existente |
| Prompt do agent pedindo y/n passa despercebido | Barra "Aprovar" + notificação clicável |
| Prompts repetidos digitados à mão | Snippets com variáveis na toolbar/paleta |
| Estado "Executando" é chute de regex | OSC 133: estado e exit code exatos |
| Restart do app = tela vazia | Scrollback restaurado + --continue |
| Workspace some se limpar dados do webview | Arquivo JSON com backup |
| Chave OpenAI em texto puro | Keyring do SO |
