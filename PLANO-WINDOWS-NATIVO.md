# Plano — Windows nativo (sem WSL) + pasta por terminal

Status (04/09/2026): implementado. Unit 223 + 157 verdes; `e2e:win` (6 cenários) e
`e2e:fit-guard:win` verdes com PTY PowerShell real; empacotado e relançado de `out/`.

Decisões (04/09/2026):
- Refatorar a fronteira de plataforma, não criar outro app.
- No Windows o app roda **nativo**: ConPTY via node-pty, PowerShell como shell,
  CLIs nativas (`claude.exe`, `codex.exe`, `cursor-agent.ps1`), caminhos `C:\…`.
- WSL sai do caminho do Windows. No Linux/macOS nada muda (já era nativo).
- Pasta de trabalho passa a ser **por terminal (pane)**; a sessão só dá o padrão.

## 1. Main process — fronteira de plataforma

- `electron/services/windows-shell.ts` (novo): resolve `pwsh.exe` → `powershell.exe`,
  traduz cwd legado (`/mnt/c/x` → `C:\x`, outro POSIX → home), `taskkill /T`.
- `pty-service.ts`: remove `WslBridge`, marker `/proc`, Git Bash, WSLENV. No win32
  o comando abstrato `powershell` vira o executável resolvido; cwd inexistente cai
  no home em vez de falhar o spawn. Kill derruba a árvore com `taskkill`.
- `system-service.ts`: sem `posixHome`/tradutor de caminho; `getDefaultCwd` →
  `Documentos`/`Documents` do home nativo; descoberta de CLI no Windows via
  `where.exe` direto (sem tentar zsh).
- `agent-sessions-service.ts`: raízes sempre no home nativo.
- `command-runner.ts`, `git-watch-service.ts`: sem runner/polling WSL; `fs.watch`
  funciona em NTFS.
- IPC/API: somem `WslInfo`, `selectWslDistro`, `toAgentPath`; fica `windowsBuild`.
- Removidos: `wsl-service.ts` (+ testes), `wsl-launch.verify.test.ts`.

## 2. Renderer — perfis PowerShell e caminhos

- `src/config/agents.ts` vira o catálogo/dispatch; builders POSIX em
  `agents-posix.ts`, builders Windows em `agents-windows.ts` (scripts PowerShell
  5.1-compatíveis via `-EncodedCommand`, OSC 7770/7771 preservados, `-NoExit`
  no lugar do `exec zsh -l`).
- `src/core/path-utils.ts`: `basenamePath`, `joinPath`, `legacyPosixToWindows`.
- Migração na hidratação: cwd POSIX persistido (era WSL) vira `C:\…` ou o cwd padrão.
- SettingsDialog perde o card WSL.

## 3. Pasta por terminal

- `LayoutNode` pane ganha `cwd?`; `resolvePaneCwd(session, paneId)`.
- Store: `updatePaneCwd(paneId, cwd)` reinicia só aquele pane; split herda a pasta
  do pane de origem.
- Header do pane ganha botão de pasta (nome curto, caminho completo no tooltip).
- `workspace-service` valida o campo novo.

## 4. Verificação

- Unit: `npm run typecheck`, `npm test`, `npm run test:electron`.
- E2E Windows: `npm run e2e:win` com caminhos nativos + cenário de pasta por pane.
- `npm run package` e relançar de `out/`.
