#!/usr/bin/env node

import { rm } from "node:fs/promises";

import { runShellLab } from "./host.mjs";
import { parseRunArgs } from "./runner-args.mjs";

try {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "shell-lab run --host electron|tauri|wails --fixture small|medium|large --review ID --profile DIR\n",
    );
    process.exit(0);
  }

  await runShellLab(parseRunArgs(args));
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
