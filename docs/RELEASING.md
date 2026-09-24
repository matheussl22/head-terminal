# Releasing

Releases are cut by the `release` workflow in `.github/workflows/release.yml`.
It runs on every push to `main` and on demand (Actions → release → Run
workflow). It reads the version from `package.json` and only builds what is
not yet attached to the GitHub release `v<version>`, so re-running it is
always safe:

1. **check** looks at the assets of release `v<version>`. Anything already
   there is not rebuilt.
2. **build** runs once per missing architecture (`macos-15` for arm64,
   `macos-15-intel` for x64) and runs `npm run make`.
3. **publish** creates the tag and the release if needed, uploads the zips
   with their `.sha256`, renders `packaging/homebrew/head-terminal.rb` with
   the version and checksums, and pushes it to the Homebrew tap. When both
   zips are already there it only makes sure the tap is up to date.

## Cutting a release

Bump the version in `package.json` and `package-lock.json`, for example with
`npm version patch --no-git-tag-version`, and merge to `main`. The workflow
does the rest. If one architecture fails, the other is published anyway and
the next run (push or "Run workflow") only rebuilds the missing one.

## Homebrew tap

The cask lives in a separate repository named `homebrew-tap` under the same
owner as this one, with the file at `Casks/head-terminal.rb`. Users install
with:

```sh
brew install --cask matheussl22/tap/head-terminal
```

One-time setup, by the owner of the tap:

1. Create the public repository `homebrew-tap`. It can be empty.
2. Create a fine-grained personal access token (GitHub → Settings → Developer
   settings → Personal access tokens → Fine-grained tokens): repository access
   only `homebrew-tap`, repository permission **Contents: Read and write**.
3. In this repository, Settings → Secrets and variables → Actions → New
   repository secret: `HOMEBREW_TAP_TOKEN` with that token.
4. Run the workflow once (Actions → release → Run workflow) to push the cask
   for the current version.

Optional: the Actions variable `HOMEBREW_TAP_REPO` (`owner/homebrew-name`)
points the workflow at a tap with another name or owner.

Without the secret, releases are still published; only the cask update is
skipped, with a warning in the run. Fine-grained tokens expire after at most
a year: when the tap step starts failing with 403, create a new token and
update the secret.

## Signing

The app is not signed or notarized. The cask clears the quarantine flag so
the app opens; a direct download needs
`xattr -dr com.apple.quarantine "/Applications/Head Terminal.app"` before the
first launch. Getting rid of that needs an Apple Developer ID and the
`osxSign` / `osxNotarize` options of Electron Forge.
