import path from "node:path";

import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

// Squirrel requires an absolute URL, and a file:// URL to the packaged icon is
// the only one that works without hosting the asset.
const WINDOWS_ICON_URL = `file:///${path
  .resolve(__dirname, "assets/icons/icon.ico")
  .replaceAll("\\", "/")}`;

// node-pty publica prebuilds N-API para win32-<arch> e darwin-<arch>, e o
// módulo os carrega direto de prebuilds/<platform>-<arch>: recompilar exigiria
// MSVC/Xcode sem ganho nenhum. Linux não tem prebuild e continua compilando.
const HAS_NODE_PTY_PREBUILD =
  process.platform === "win32" || process.platform === "darwin";

const config: ForgeConfig = {
  packagerConfig: {
    // Em POSIX o node-pty inicia cada pane por um binário auxiliar,
    // `spawn-helper`, que fica ao lado do `.node`. O AutoUnpackNativesPlugin
    // só tira do ASAR o que termina em `.node`; um executável dentro do
    // arquivo não pode ser `exec`ado, e o pane morre com "posix_spawn failed".
    // O módulo é copiado para dentro de `.vite/`, um diretório oculto, e `**`
    // não atravessa nomes que começam com ponto: `**/spawn-helper` sozinho
    // não casa nada e o binário fica preso no ASAR. A forma `{.**,**}` é a
    // mesma que o AutoUnpackNativesPlugin usa para o `.node`.
    // No Windows não existe o arquivo, e o glob não muda nada lá.
    asar: process.platform === "win32" ? true : { unpack: "**/{.**,**}/**/spawn-helper" },
    appBundleId: "com.matheus.head-terminal",
    appCategoryType: "public.app-category.developer-tools",
    appCopyright: "Copyright © 2026 Matheus",
    executableName: "head-terminal",
    icon: "assets/icons/icon",
    darwinDarkModeSupport: true,
    // Info.plist do .app. Sem a descrição de uso o macOS mata o processo na
    // primeira tentativa de abrir o microfone (ditado F9, brainstorm F10) em
    // vez de perguntar ao usuário.
    extendInfo: {
      NSMicrophoneUsageDescription:
        "O Head Terminal usa o microfone para o ditado por voz e para o brainstorm por voz com os agentes.",
    },
  },
  rebuildConfig: HAS_NODE_PTY_PREBUILD ? { onlyModules: [] } : {},
  makers: [
    new MakerZIP({}, ["darwin"]),
    new MakerSquirrel(
      {
        name: "head-terminal",
        setupExe: "head-terminal-setup.exe",
        setupIcon: "assets/icons/icon.ico",
        iconUrl: WINDOWS_ICON_URL,
        // Code signing is a known gap, as is macOS notarization. Squirrel
        // still produces a working installer without it.
      },
      ["win32"],
    ),
    new MakerDeb({
      options: {
        name: "head-terminal",
        productName: "Head Terminal",
        genericName: "AI Agent Terminal",
        description: "Terminal desktop para AI coding agents",
        productDescription:
          "Terminal Electron com sessões, splits, Git e PTYs independentes para AI coding agents.",
        section: "devel",
        priority: "optional",
        maintainer: "Matheus",
        bin: "head-terminal",
        categories: ["Development", "Utility"],
        icon: "assets/icons/icon.png",
        desktopTemplate: path.resolve(
          __dirname,
          "scripts/packaging/head-terminal.desktop.ejs",
        ),
      },
    }),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: "electron/main.ts",
          config: "vite.main.config.ts",
          target: "main",
        },
        {
          entry: "electron/preload.ts",
          config: "vite.preload.config.ts",
          target: "preload",
        },
      ],
      renderer: [
        {
          name: "main_window",
          config: "vite.renderer.config.ts",
        },
      ],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
