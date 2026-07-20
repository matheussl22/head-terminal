# Migração completa para Electron

Status: concluída em 19/07/2026 no clone `head-terminal-electron`.

O projeto original `head-terminal` não é usado pelo build novo e permaneceu sem alterações. Este documento registra o escopo migrado, decisões de arquitetura, compatibilidade de dados e gates usados para o cutover.

## Arquitetura final

```text
React / xterm / Zustand (renderer sandboxed)
                  │
                  ▼
       preload + window.headTerminal
                  │ IPC tipado/validado
                  ▼
Electron main
  ├─ PtyService (node-pty)
  ├─ GitService + GitWatchService
  ├─ SystemService
  ├─ VoiceService
  ├─ McpService
  ├─ SecretService (safeStorage)
  ├─ WorkspaceService
  ├─ MigrationService
  └─ DiagnosticService
```

O renderer não recebe Node, filesystem, `ipcRenderer` nem material secreto. A janela usa `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, CSP, navegação bloqueada e permissões web negadas. Toda capacidade privilegiada passa por canais nomeados, sender/frame confiável, limites de payload e validação no main.

## Matriz de paridade

| Área | Implementação Electron | Validação |
|---|---|---|
| PTY por pane | `node-pty` no main, eventos data/exit, write/resize/kill | PTY real, Unicode, ANSI/OSC, resize, Ctrl-C e exit code |
| Splits e sessões | renderer React preservado, bridge assíncrona | suíte core e smoke empacotado |
| Vários terminais | registry por `webContents.id + paneId` | seis PTYs reais simultâneos |
| Cleanup | owner cleanup, shutdown e árvore de descendentes Linux | teste de job em background/órfão |
| Perfis de agents | Antigravity, Cursor, Claude, Codex e shell | launcher preservado; spawn inicial limitado a zsh |
| Git | contexto, diff, untracked, worktree `agent-N` | testes de serviço/watch |
| Git watch | deduplicação, debounce e worktrees | integração e testes renderer |
| MCP | leitura Claude/Cursor, cache e timeout | testes de parser/serviço |
| Voz | `parecord` no main + transcrição OpenAI | lifecycle, cancelamento e cleanup testados |
| Segredos | `safeStorage`, allowlist e arquivo atômico | backend inseguro `basic_text` recusado |
| Clipboard | API Electron restrita | contrato IPC |
| Notificações | notificação nativa, foco e seleção da sessão | canal main → renderer tipado |
| Diagnóstico | logs, checkpoints, rotação, flush e export | testes de serviço |
| Workspace | JSON v1 atômico, fila, quarentena e limites | save/load/corrupção/schema |
| Preferências | importação e aplicação única sem sobrescrever escolhas novas | testes core/migração |
| Instância única | lock e foco da janela existente | lifecycle Electron |
| Fechamento | confirmação, persistência aguardada e cleanup | contrato IPC e runtime |
| Desktop Linux | Forge + maker `.deb` + entry/icon | inspeção do `.deb` final |

## Compatibilidade e migração de dados

Na primeira abertura, o main procura os bancos WebKit antigos em modo somente leitura e importa:

- workspace/sessões;
- preferências visuais e de agents;
- chave OpenAI somente se `safeStorage` oferecer criptografia real.

A chave nunca é devolvida ao renderer. O importador exclui plaintext do snapshot de preferências, usa marker validado e grava destino/marker atomicamente. Payloads inválidos não concluem a migração e podem ser tentados novamente. Dados atuais do Electron sempre vencem dados antigos.

Dev e produção usam diretórios `userData` separados. Smoke e E2E recebem `--user-data-dir` temporário e não escrevem no perfil real.

## Empacotamento nativo

O Vite externaliza `node-pty`. Um plugin local copia somente os arquivos runtime da plataforma para `.vite/build/native/node-pty`; o Forge inclui o JavaScript no ASAR e `AutoUnpackNativesPlugin` coloca `pty.node` em `app.asar.unpacked`.

O smoke não aceita apenas uma janela aberta: ele espera `js.pty.spawn_ok` de um shell real no pacote e falha diante de `spawn_failed` ou ausência de `node-pty`.

## Gates de cutover

- `npm run typecheck`;
- `npm test` — 23 arquivos, 83 testes;
- `npm run test:electron` — 12 arquivos, 68 testes;
- `bash -n scripts/*.sh`;
- `git diff --check`;
- `npm audit --omit=dev` — zero vulnerabilidades;
- `npm run package`;
- `npm run smoke:electron:existing` — janela de produção + PTY real;
- `npm run make` — `.deb` Linux x64;
- inspeção do `.deb` confirmando desktop entry, binário e `pty.node` desempacotado.

## Cutover

O backend Rust/Tauri, plugins, scripts npm e assets de boilerplate foram removidos. Os ícones foram movidos para `assets/icons`. Referências a Tauri que permanecem no código pertencem exclusivamente ao leitor de banco legado e devem continuar durante a janela de migração de usuários.

Os documentos `PLANO-REFATORACAO*.md` foram marcados como históricos. A arquitetura vigente está neste documento, no `README.md` e em `electron/`.

## Limites de plataforma

O fluxo validado e distribuível é Linux x64, correspondente ao ambiente original. O ZIP macOS pode ser produzido em um host macOS, mas distribuição pública requer assinatura/notarização; a voz depende atualmente de `parecord` e, portanto, fica indisponível no macOS até receber backend próprio. Windows não é anunciado nem gerado nesta etapa.
