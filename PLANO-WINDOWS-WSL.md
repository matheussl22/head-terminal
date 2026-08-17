# Plano — Head Terminal no Windows com WSL

Alvo: aplicativo Electron **nativo do Windows** (instalador, ícone na barra,
notificações do sistema) em que cada pane abre seu PTY **dentro do WSL**. Os
agentes (`claude`, `codex`, `cursor`, `agy`), o `git` e os repositórios
continuam vivendo no ext4 do WSL. O Windows é só a casca gráfica.

```text
Windows
└── Electron 41 + React + xterm.js        (nativo, ConPTY)
      └── node-pty → wsl.exe -d Ubuntu --cd /home/matheus/x -- /usr/bin/zsh -l -c "…"
            └── zsh, claude/codex/cursor, git, ~/.claude/projects   (Linux)
```

## O princípio que segura o plano

**A fronteira Windows↔WSL mora no processo main, e em nenhum outro lugar.**

O renderer continua mandando `command: "/usr/bin/zsh"` com os mesmos `args` de
hoje (`src/core/pty-bridge.ts:42`). Todo o mecanismo de lançamento em
`src/config/agents.ts` — o `zsh -l -c`, o `$SECONDS` do resume fallback, o
`exec zsh -l`, os OSC 7770/7771 — permanece **intocado**, porque continua
rodando dentro de um Linux de verdade. O main é que, ao ver `process.platform
=== "win32"`, embrulha aquele argv em `wsl.exe` antes de entregar ao node-pty.

Isso vale também para a validação em `electron/ipc/register.ts:400`: ela segue
exigindo `/bin/zsh` ou `/usr/bin/zsh`, e o embrulho acontece **depois** dela.
O limite de `args.length > 3` continua válido pelo mesmo motivo.

Corolário: em qualquer serviço que hoje chama um binário externo ou lê um
caminho, o código passa a falar POSIX e a tradução acontece numa única camada.

## Duas peças novas

### `electron/services/wsl-service.ts`

- `isWslMode(): boolean` — `process.platform === "win32"` e há distro utilizável.
- `detectDistro(): Promise<string>` — `wsl.exe -l -q`, com escolha manual
  persistida nas configurações quando houver mais de uma.
- `wrapArgv(command, args, cwd): { file, args }` — devolve
  `wsl.exe` + `["-d", distro, "--cd", cwd, "--", command, ...args]`.
- `toWindowsPath(posix): string` — `/home/matheus/x` →
  `\\wsl.localhost\Ubuntu\home\matheus\x`.
- `toPosixPath(windows): string` — inverso, incluindo `C:\…` → `/mnt/c/…`.
- `home(): Promise<string>` — o `$HOME` do WSL, não `os.homedir()`.

Testável sem Windows: tudo é função pura sobre strings, exceto `detectDistro`,
que recebe o runner por injeção.

### Um `CommandRunner` injetável

Hoje há três `execFile` diretos, cada um com sua própria promessa:
`git-service.ts:45`, `mcp-service.ts:59`, `system-service.ts:56`. Passam a
receber um runner comum, que no Linux executa direto e no Windows prefixa
`wsl.exe -d <distro> --cd <cwd> --`. Os serviços não sabem em qual dos dois estão.

## Inventário do que quebra

Levantado lendo o código atual, não por suposição.

| # | Onde | O que acontece no Windows |
|---|---|---|
| 1 | `pty-service.ts:213` `linuxDescendants` | Lê `/proc/<pid>/task/<pid>/children`. No Windows o PID é o do `wsl.exe`; os PIDs dos filhos são internos ao WSL e `process.kill` do Node não alcança nenhum deles. |
| 2 | `pty-service.ts:404` | O ramo já pula tudo em `win32`, então matar o `wsl.exe` deixa `claude`/`node` órfãos rodando dentro da distro. |
| 3 | `system-service.ts:30` `getDefaultCwd` | `homedir()` devolve `C:\Users\...\Documentos`, que não existe do lado do WSL. |
| 4 | `system-service.ts:56` | `execFile("zsh", ["-lc", …])` para descobrir os CLIs: não há `zsh` no Windows. |
| 5 | `git-service.ts:46` | `execFile("git")` usaria o Git do Windows sobre `\\wsl.localhost`: lento, com permissões e `core.filemode` errados. |
| 6 | `mcp-service.ts:59` | `execFile(binary, ["mcp","list"])` — mesmo problema, o binário está no WSL. |
| 7 | `agent-sessions-service.ts:38-40` | Raízes `~/.claude/projects`, `~/.codex`, `~/.cursor/projects` a partir de `homedir()` do Windows. Já são **injetáveis** (existe o seam de teste), então é só apontá-las para o home do WSL. |
| 8 | `agent-sessions-service.ts:474` | `encodeCursorProjectDir` faz `cwd.split("/")`. Continua correto **desde que** o `cwd` que circula no app seja sempre POSIX — é o que este plano garante. |
| 9 | `git-watch-service.ts` | `inotify` não atravessa o 9p/virtiofs: mudanças feitas dentro do WSL não disparam evento em `\\wsl.localhost`. O watcher fica mudo. |
| 10 | `voice-service.ts:96` | `parecord` não existe no Windows. |
| 11 | `migration-service.ts:196,202` e `diagnostic-service.ts:19` | Ternários `linux ? … : macOS`. No Windows caem no ramo do macOS e vão gravar em `~/Library/Application Support`. |
| 12 | `secret-service.ts:66` | Sem problema real: `safeStorage` no Windows usa DPAPI. Só confirmar que a checagem de `basic_text`, hoje condicionada a `linux`, não atrapalha. |
| 13 | `package.json` scripts | `NODE_ENV=production electron-forge package` não funciona em cmd/PowerShell, e sete scripts chamam `bash scripts/*.sh`. |
| 14 | `forge.config.ts` | Só há `MakerDeb` e `MakerZIP`. Falta maker do Windows e ícone `.ico`. |
| 15 | `scripts/electron-smoke.sh`, `scripts/e2e.sh` | Dependem de Xvfb e `xdotool`. Não portam. |

## Fases

### Fase 0 — ambiente (meio dia)

WSL2 com a distro escolhida e `zsh`, `git`, `claude`, `codex` instalados
dentro dela. Do lado Windows: Node 20 (mesma baseline do README), Visual
Studio Build Tools com a carga C++ e Python 3, exigidos pelo rebuild do
`node-pty`. Confirmar `wsl.exe -l -q` e o acesso a `\\wsl.localhost\<distro>`.

### Fase 1 — compilar e abrir a janela (1-2 dias)

Ainda sem WSL nenhum: o objetivo é só ver a janela subir no Windows.

- `cross-env` nos scripts de `dev`/`package`/`make`, ou mover o `NODE_ENV`
  para dentro do `forge.config.ts`.
- Reescrever `start:dev`/`start:prod`/`install:desktop` em Node, ou marcá-los
  como exclusivos de Linux — hoje são `bash` puro.
- `node-pty` reconstruído para o Electron 41 no Windows; conferir que o
  `AutoUnpackNativesPlugin` desempacota `conpty.node` e as DLLs junto.
- `assets/icons/icon.ico` e `MakerSquirrel` no `forge.config.ts`.
- Terceiro ramo `win32` em `migration-service.ts` e `diagnostic-service.ts`,
  apontando para `%LOCALAPPDATA%`.

Fim da fase: o app abre no Windows e um pane com `powershell.exe` escreve na
tela. Não é o produto, é a prova de que o ConPTY e o empacotamento funcionam.

### Fase 2 — o PTY dentro do WSL (2-3 dias) — o coração

- `wsl-service.ts` completo, com testes de tabela para as traduções de caminho.
- `PtyService.spawn` passa o argv por `wrapArgv` quando `isWslMode()`.
- `getDefaultCwd` devolve o `$HOME` do WSL.
- Seleção de distro na tela de configurações, persistida no workspace.

Fim da fase: um pane roda `claude` de verdade, dentro do WSL, com o `cwd`
certo, e o fallback de shell e o resume continuam funcionando — porque nada
em `agents.ts` foi tocado.

### Fase 3 — os serviços que leem o Linux (2-3 dias)

`CommandRunner` injetado em `git-service`, `mcp-service` e na descoberta de
CLIs do `system-service`. As raízes de sessão do `agent-sessions-service`
apontadas para o home do WSL via UNC — leitura de arquivo por UNC é aceitável
aqui porque são leituras esparsas e pequenas, ao contrário do watcher.

Ponto de atenção: o `git` rodando via `wsl.exe` recebe caminhos POSIX, o que
já é o formato que o resto do app usa. Nenhuma tradução deve aparecer nas
mensagens de erro mostradas ao usuário.

### Fase 4 — encerrar processos sem deixar órfão (1-2 dias)

O item mais fácil de esquecer e o que mais incomoda no uso diário. Em vez de
`readFileSync` em `/proc`, a varredura de descendentes passa a rodar **dentro**
do WSL, e o `SIGTERM` também. Na prática: um comando único enviado por
`wsl.exe` que descobre a árvore a partir do PID do shell e a encerra de baixo
para cima, replicando a semântica que hoje está em `pty-service.ts:395-425`.

Precisa de teste manual explícito: fechar um pane com `claude` ocupado e
conferir com `ps aux` dentro do WSL que não sobrou nada.

### Fase 5 — watcher e desempenho (1-2 dias)

O `git-watch-service` sobre `\\wsl.localhost` não recebe eventos. Duas saídas:
polling com intervalo maior no modo WSL, ou um processo leve dentro da distro
que observe e reporte. Começar pelo polling, medir, e só então decidir se vale
o processo auxiliar.

### Fase 6 — voz, notificações e instalador (2-3 dias)

- Voz: `parecord` não porta. O caminho mais limpo é gravar no renderer com
  `getUserMedia`/`MediaRecorder` e mandar o buffer para o main, o que de quebra
  resolve o macOS, que hoje tem o mesmo buraco. Até lá, esconder o botão no
  Windows em vez de deixá-lo falhando.
- Notificações nativas: verificar o `AppUserModelId`, sem o qual o Windows
  silencia as notificações do Electron.
- `MakerSquirrel` gerando instalador; assinatura de código fica como pendência
  conhecida, igual à notarização do macOS.

### Fase 7 — testes e CI (1-2 dias)

Os testes de unidade e de contrato de IPC rodam no Windows sem mudança. O que
precisa de trabalho é o smoke: `electron-smoke.sh` e `e2e.sh` dependem de
Xvfb e `xdotool`. Escrever um smoke equivalente em Node para o Windows, que
suba o pacote e confirme a janela, e manter o de X11 só no Linux.

## Riscos

**O que mais pode custar tempo:** a árvore de processos da Fase 4. O
`wsl.exe` é uma ponte fina, e o comportamento dele quando o processo do
Windows morre com filhos vivos do lado Linux não é bem documentado. Vale
provar isso cedo — um experimento de meia hora na Fase 2 evita descobrir na
Fase 4 que o desenho precisa mudar.

**Latência do `wsl.exe`:** cada invocação de `git` paga a partida da ponte.
Hoje o `git-service` chama `git` várias vezes por atualização de contexto. Se
ficar perceptível, agrupar as chamadas num único `zsh -c` com vários comandos.

**Manter dois sistemas vivos:** cada `execFile` novo que alguém escrever sem
passar pelo runner volta a quebrar o Windows em silêncio. Vale uma regra de
lint, ou pelo menos um comentário no topo dos serviços.

**Não fazer:** reescrever o `agents.ts` para PowerShell. É o que transformaria
este plano em um projeto de meses, e é exatamente o que o desenho acima evita.

## Decisões ainda abertas

1. Distro fixa ou escolhida pelo usuário? O plano assume escolha persistida,
   com detecção automática quando só houver uma.
2. Repositórios em `/mnt/c` devem ser suportados ou recusados com uma
   mensagem clara? A tradução já cobre o caso, mas git e watcher ficam lentos
   o bastante para incomodar.
3. O `%LOCALAPPDATA%` do Windows e o `~/.local/share` do WSL guardam workspaces
   separados. Isso é o esperado, ou o usuário espera ver as mesmas sessões nos
   dois lados?
