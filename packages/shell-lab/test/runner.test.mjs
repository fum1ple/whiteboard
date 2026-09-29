import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseRunArgs } from "../src/runner-args.mjs";
import { createRunContext } from "../src/run-context.mjs";
import { createReadyGate } from "../src/ready-gate.mjs";

test("run arguments require a host, fixture, review, and isolated profile", () => {
  assert.deepEqual(
    parseRunArgs([
      "run",
      "--host",
      "electron",
      "--fixture",
      "small",
      "--review",
      "review-123",
      "--profile",
      "/tmp/profile-a",
    ]),
    {
      host: "electron",
      fixture: "small",
      reviewId: "review-123",
      profileDir: "/tmp/profile-a",
    },
  );
});

test("run arguments reject missing, unknown, and repeated options", () => {
  for (const args of [
    ["run", "--host", "unknown", "--fixture", "small", "--review", "r", "--profile", "/tmp/p"],
    ["run", "--host", "electron", "--fixture", "small", "--review", "r"],
    ["run", "--host", "electron", "--host", "wails", "--fixture", "small", "--review", "r", "--profile", "/tmp/p"],
  ]) {
    assert.throws(() => parseRunArgs(args));
  }
});

test("run context isolates profile and fixture paths beneath the run id", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "whiteboard-shell-lab-"));

  try {
    const context = await createRunContext({
      runId: "run-1",
      profileDir: path.join(root, "profiles"),
      fixture: "small",
    });

    assert.equal(context.profileDir, path.join(root, "profiles", "run-1"));
    assert.equal(context.fixtureDir, path.join(root, "fixtures", "small"));
    assert.equal((await readFile(path.join(context.profileDir, ".shell-lab-run"), "utf8")).trim(), "run-1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ready gate opens only after prose, diagram, diff, and code reference render", async () => {
  const gate = createReadyGate({ runId: "run-1", timeoutMs: 100 });
  gate.markRendered("prose");
  gate.markRendered("diagram");
  gate.markRendered("diff");
  assert.equal(gate.ready, false);
  gate.markRendered("code-reference");
  assert.equal(gate.ready, true);
  assert.deepEqual(await gate.wait(), { runId: "run-1", rendered: ["prose", "diagram", "diff", "code-reference"] });
  gate.dispose();
});

test("ready gate rejects an incomplete render and ignores duplicate marks", async () => {
  const gate = createReadyGate({ runId: "run-2", timeoutMs: 10 });
  gate.markRendered("prose");
  gate.markRendered("prose");
  await assert.rejects(gate.wait(), /timed out.*diagram.*diff.*code-reference/i);
  gate.dispose();
});
