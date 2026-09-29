#!/usr/bin/env node

import { prepareFixtures } from "./prepare-fixtures.mjs";

const args = process.argv.slice(2);

if (args.some((value) => value !== "--force")) {
  process.stderr.write("Usage: shell-lab-prepare-fixtures [--force]\n");
  process.exitCode = 2;
} else {
  try {
    await prepareFixtures({ force: args.includes("--force") });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
