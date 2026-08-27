#!/usr/bin/env node
// Alias of `npm run e2e:win -- --only=clipboard` (keeps the original script path).
import { runWinE2e } from "./e2e-win.mjs";

await runWinE2e({ only: ["clipboard"] });
