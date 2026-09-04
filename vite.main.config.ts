import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { defineConfig } from "vite";

/**
 * Debug symbols are not needed at runtime and are the bulk of the prebuilds
 * (~29 MB of `.pdb` on Windows). Copying them raced Vite's file watcher on
 * the build output — `EBUSY` on a half-written `.pdb` took `forge start` down
 * before Electron ever launched.
 */
function isRuntimeFile(source: string): boolean {
  return !source.toLowerCase().endsWith(".pdb");
}

async function copyIfPresent(source: string, destination: string): Promise<void> {
  await cp(source, destination, { recursive: true, filter: isRuntimeFile }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}

export default defineConfig({
  plugins: [
    {
      name: "head-terminal:package-node-pty",
      async closeBundle() {
        // Forge's Vite plugin packages only `.vite`. Keep the external native
        // module inside that tree so ASAR includes it and the native addon is
        // automatically unpacked by AutoUnpackNativesPlugin.
        const source = path.resolve(__dirname, "node_modules/node-pty");
        const destination = path.resolve(
          __dirname,
          ".vite/build/native/node-pty",
        );
        await rm(destination, { recursive: true, force: true });
        await mkdir(destination, { recursive: true });
        await Promise.all([
          copyIfPresent(path.join(source, "package.json"), path.join(destination, "package.json")),
          copyIfPresent(path.join(source, "LICENSE"), path.join(destination, "LICENSE")),
          copyIfPresent(path.join(source, "lib"), path.join(destination, "lib")),
          copyIfPresent(
            path.join(source, "build", "Release"),
            path.join(destination, "build", "Release"),
          ),
          copyIfPresent(
            path.join(source, "prebuilds", `${process.platform}-${process.arch}`),
            path.join(destination, "prebuilds", `${process.platform}-${process.arch}`),
          ),
        ]);
      },
    },
  ],
  build: {
    rollupOptions: {
      external: ["node-pty"],
    },
  },
});
