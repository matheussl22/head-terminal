# Head Terminal

Terminal desktop focado em **AI coding agents** (Antigravity, Claude Code, Codex, etc.).

- Tema preto/branco fixo
- Toolbar com `/clear`, `/compact`, `/context`, `/help`
- Spawn automático do agent com fallback para `zsh`
- Linux + macOS via Tauri 2

## Stack

| Camada | Tecnologia |
|--------|------------|
| Shell app | Tauri 2 |
| UI | React 19 + TypeScript + Vite |
| Terminal | xterm.js |
| PTY | tauri-plugin-pty |

## Pré-requisitos

### macOS

```bash
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Linux (Ubuntu/Debian)

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

### Ambos

- Node.js 20+
- Rust stable

## Comandos

```bash
cd ~/Documentos/head-terminal
npm install
npm run tauri dev      # desenvolvimento
npm run tauri build    # build de produção
npm run build          # só frontend
```

## Atalho no menu Ubuntu (favoritar no dock)

O GNOME só mostra **“Adicionar aos favoritos”** quando o `.desktop` tem `StartupWMClass`
igual ao da janela do app.

**Modo desenvolvimento** (abre via `npm run tauri dev`):

```bash
npm run install:desktop
```

Depois: menu de aplicativos → busque **Head Terminal** → clique direito → **Adicionar aos favoritos**.

**Modo produção** (após build):

```bash
npm run tauri build
sudo apt install ./src-tauri/target/release/bundle/deb/head-terminal_*.deb
```

Ou, para apontar o atalho local ao binário release:

```bash
npm run install:desktop:release
```

Se o favorito não agrupar com a janela aberta, reinicie a sessão GNOME (`Alt+F2` → `r`) após instalar o atalho.

### Erro ao reabrir pelo menu

O atalho **Head Terminal** usa o binário de **produção** (estável). Se você favoritou o modo dev por engano, ou o atalho apontava para `tauri dev`, ao fechar a janela o Vite podia continuar na porta `1420` e a segunda abertura falhava.

**Correção:**

```bash
cd ~/Documentos/head-terminal
npm run build:release      # se ainda não compilou
npm run install:desktop    # recria os atalhos Dev + Prod
```

Depois remova o favorito antigo do dock e adicione de novo **Head Terminal** (sem “Dev”).

| Atalho no menu | Uso |
|----------------|-----|
| **Head Terminal** | Uso diário — abre/fecha normalmente pelo dock |
| **Head Terminal (Dev)** | Só para editar UI — hot reload mata sessões do agent |

## Atalhos

| Atalho | Ação |
|--------|------|
| Ctrl+Shift+L | `/clear` no terminal ativo (ou em todos com Run everything) |

## Sessões e splits

- **+ Nova** na sidebar cria outra sessão (PTY independente)
- Trocar de sessão não encerra os agents — tudo continua em background
- **Split ↓ / Split →** divide o terminal ativo da sessão atual
- **Run everything**: comandos da toolbar vão para todos os terminais da sessão

## Configuração de agents

Perfis em `src/config/agents.ts`. O padrão spawna:

| Agent | Comando |
|-------|----------|
| Antigravity | `agy` |
| Cursor Agent | `cursor agent` |
| Claude Code | `claude` |
| Codex CLI | `codex` |
| Shell | `zsh -l` |

Agent primeiro (Cursor Agent), shell normal ao sair.

## Estrutura

```
src/
├── actions/          # sendAgentCommand
├── components/       # AppShell, toolbar, terminal
├── config/           # theme, agents, toolbar
├── core/             # session manager, pty bridge
├── hooks/            # useAgentSession
└── types/
```

## Próximas fases

- Múltiplas abas ativas
- Botão "+ Nova" na sidebar
- Persistência de sessões
- Split pane agent + shell
