import { readFile, writeFile } from "node:fs/promises";

import { summarizeRuns } from "./summarize.mjs";

const inputPath = process.argv[2];

const outputPath = process.argv[3];

if (!inputPath)
  throw new Error("Usage: shell-lab bench:summarize RAW.json [SUMMARY.json]");

const raw = JSON.parse(await readFile(inputPath, "utf8"));

const summary = summarizeRuns(raw);

const serialized = `${JSON.stringify(summary, null, 2)}\n`;

if (outputPath) await writeFile(outputPath, serialized, { mode: 0o600 });
else process.stdout.write(serialized);
