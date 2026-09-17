# Cask do Homebrew para o Head Terminal.
#
# Este arquivo nao e lido daqui: o Homebrew so carrega cask de um tap. Para
# publicar, copie-o para Casks/head-terminal.rb em um repositorio chamado
# `homebrew-tap` (ex.: matheussl22/homebrew-tap) e a instalacao passa a ser:
#
#     brew install --cask matheussl22/tap/head-terminal
#
# A cada release, atualize `version` e os dois `sha256` com os valores que o
# workflow .github/workflows/release.yml publica no resumo da execucao e nos
# arquivos .sha256 anexados a release.
cask "head-terminal" do
  arch arm: "arm64", intel: "x64"

  version "0.1.1"
  sha256 arm:   "PREENCHER_SHA256_ARM64",
         intel: "PREENCHER_SHA256_X64"

  url "https://github.com/matheussl22/head-terminal/releases/download/v#{version}/head-terminal-darwin-#{arch}-#{version}.zip"
  name "Head Terminal"
  desc "Terminal desktop para AI coding agents"
  homepage "https://github.com/matheussl22/head-terminal"

  depends_on macos: :big_sur

  app "Head Terminal.app"

  # O app ainda nao e assinado nem notarizado, entao o Gatekeeper bloquearia o
  # bundle que o Homebrew acabou de colocar em quarentena. Isto so e aceitavel
  # em tap proprio; o homebrew-cask oficial recusa. Remova quando houver
  # Developer ID e notarizacao.
  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Head Terminal.app"]
  end

  zap trash: [
    "~/.head-terminal",
    "~/Library/Application Support/Head Terminal",
    "~/Library/Preferences/com.matheus.head-terminal.plist",
    "~/Library/Saved Application State/com.matheus.head-terminal.savedState",
  ]
end
