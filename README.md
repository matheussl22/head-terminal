# Head Terminal

Terminal desktop para trabalhar com vários AI coding agents em paralelo. A aplicação usa Electron com uma UI React, um PTY nativo independente por pane e uma API restrita entre renderer e sistema operacional.

## Funcionalidades

- sessões persistidas, fixação, renomeação, reordenação e troca rápida;
- splits horizontais e verticais redimensionáveis, cada um com seu próprio PTY;
- spawn lazy, restart por pane e preservação do scrollback;
- perfis Antigravity, Cursor Agent, Claude Code, Codex e shell;
- múltiplas contas Claude e worktrees Git `agent-N` opcionais;
- busca, zoom, links, clipboard e renderização WebGL com fallback;
- detecção de atividade, contexto restante, quedas e shell de fallback;
- contexto, watcher e diff Git, inclusive arquivos não rastreados;
- status MCP para Claude e Cursor;
- voz com gravação local e transcrição OpenAI;
- notificações, logs, checkpoints e exportação de diagnóstico;
- instância única e confirmação antes de fechar agents trabalhando.

## Arquitetura

```text
React 19 + xterm.js + Zustand
              │
              ▼
window.headTerminal (preload tipado)
              │ IPC nomeado e validado
              ▼
Electron main ── node-pty / Git / filesystem / safeStorage / voz
```

O renderer não possui acesso a Node ou ao `ipcRenderer`. A janela usa `contextIsolation`, sandbox, CSP e `nodeIntegration: false`. Main e preload são empacotados pelo Vite; Electron Forge reconstrói e desempacota `node-pty` dentro do pacote.

| Área | Tecnologia |
|---|---|
| Desktop | Electron 41 + Electron Forge |
| UI | React 19 + TypeScript + Vite |
| Terminal | xterm.js + node-pty |
| Estado | Zustand + workspace JSON versionado |
| Testes | Vitest + smoke Electron/X11 |

## Pré-requisitos

### Todos os sistemas

- Node.js 20 (o baseline atual é Node `20.18.3`);
- npm;
- toolchain nativa para compilar módulos Node (`node-pty`);
- ao menos um shell suportado instalado.

Instale as dependências JavaScript com:

```bash
npm install
```

### Linux (Ubuntu/Debian)

```bash
sudo apt install build-essential python3 make g++ libsecret-1-0
```

Para gravação por voz:

```bash
sudo apt install pulseaudio-utils
command -v parecord
```

O smoke e o harness visual usam `xdotool` e, preferencialmente, um display isolado:

```bash
sudo apt install xvfb xdotool imagemagick
```

Em Wayland, a aplicação funciona via Electron/Ozone, mas a automação visual atual usa X11/XWayland. A gravação implementada hoje depende de `parecord`; sem ele, somente voz fica indisponível.

### macOS

```bash
xcode-select --install
```

Desenvolvimento e pacote ZIP são suportados. A distribuição pública ainda exige configurar assinatura, hardened runtime, entitlements e notarização. A captura de voz atual usa `parecord`, portanto voz no macOS ainda requer um backend nativo próprio antes de ser considerada suportada.

## Comandos

```bash
npm run dev                         # Electron + Vite com hot reload
npm run typecheck                   # renderer, main, preload e configs
npm test                            # testes do renderer/core
npm run test:electron               # services e contrato IPC
npm run package                     # app unpacked em out/
npm run make                        # artefatos de distribuição da plataforma
npm run build                       # typecheck + package
npm run smoke:electron              # package + boot real e verificação da janela
npm run smoke:electron:existing     # smoke no pacote já existente
```

No Linux, `npm run make` produz o `.deb` em `out/make/deb/`. No macOS, produz ZIP. Builds devem ser feitos na plataforma de destino; módulos nativos não são portáveis entre sistemas ou versões do Electron.

O runtime e o empacotamento são exclusivamente Electron; o backend Tauri/Rust foi removido. O leitor WebKit no processo principal existe somente para importar, uma única vez, dados de instalações antigas.

## Launchers no Linux

O instalador local cria duas entradas sem precisar de `sudo`:

```bash
npm run install:desktop             # instala Head Terminal (Dev)
npm run package
npm run install:desktop:release     # instala também Head Terminal
```

| Entrada | Destino |
|---|---|
| Head Terminal | pacote Electron em `out/Head Terminal-linux-x64/` |
| Head Terminal (Dev) | `npm run dev`, com Vite e hot reload |

O modo dev usa launcher, logs, classe de janela e diretório de dados próprios; não o use para sessões que não podem ser interrompidas por reload.

Para instalar o pacote Debian gerado:

```bash
npm run make
sudo apt install ./out/make/deb/x64/head-terminal_*.deb
```

## Atalhos principais

| Atalho | Ação |
|---|---|
| `Ctrl+Shift+P` | abrir paleta de comandos |
| `Ctrl+F` | buscar no terminal ativo |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | copiar / colar |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | zoom |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | próxima / sessão anterior |
| `Ctrl+1..9` | selecionar sessão |
| `Ctrl+Shift+L` | `/clear` no terminal ativo ou em todos |

Os botões `Split ↓` e `Split →` dividem o pane ativo. “Run everything” envia comandos da toolbar a todos os panes da sessão.

## Agents

Os perfis ficam em `src/config/agents.ts`:

| Perfil | Executável esperado |
|---|---|
| Antigravity | `agy` |
| Cursor Agent | `cursor` |
| Claude Code | `claude` |
| Codex CLI | `codex` |
| Shell | shell configurado / `zsh` |

O Head Terminal herda o ambiente do launcher gráfico e completa `PATH`, locale e variáveis de terminal antes de iniciar o PTY.

## Estrutura

```text
electron/
├── main.ts              # lifecycle e BrowserWindow
├── preload.ts           # window.headTerminal
├── ipc/                 # canais, validação e handlers
├── services/            # PTY, Git, sistema, segredo, voz e persistência
└── types/               # contrato compartilhado
src/
├── actions/
├── components/
├── config/
├── core/
├── hooks/
└── types/
tests/electron/          # services, contrato IPC e infraestrutura Electron
scripts/                 # launchers, E2E e smoke
```

## Validação e diagnóstico

O smoke encerra o grupo de processos mesmo em falha e usa Xvfb quando não existe um `DISPLAY` utilizável. Para exigir display/xdotool em CI:

```bash
HEAD_TERMINAL_SMOKE_REQUIRE_DISPLAY=1 npm run smoke:electron
```

O harness interativo oferece screenshot, teclado e clique num display isolado:

```bash
npm run e2e -- start
npm run e2e -- shot /tmp/head-terminal.png
npm run e2e -- key ctrl+shift+p
npm run e2e -- stop
```

Falhas do launcher local ficam em `~/.local/share/head-terminal/logs/`.
