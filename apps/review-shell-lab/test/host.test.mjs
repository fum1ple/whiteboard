import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createHost } from "../src/host.mjs";

test("host start returns readiness only after the shared UI reports all renders", async () => {
  const profileDir = await mkdtemp(
    path.join(os.tmpdir(), "shell-host-profile-"),
  );

  let apiStopped = false;
  let shellClosed = false;
  let processStopped = false;
  const fakeProcess = new EventEmitter();
  fakeProcess.pid = 99;
  fakeProcess.exitCode = null;
  fakeProcess.signalCode = null;
  fakeProcess.kill = () => {
    processStopped = true;
    fakeProcess.exitCode = 0;
    fakeProcess.emit("exit", 0, null);
  };

  const host = createHost("electron", {
    reviewId: "review-id",
    fixture: "small",
    copyProfile: async () => {},
    startApi: async () => ({
      url: "http://127.0.0.1:5000",
      token: "review-token",
      serverPid: 101,
      instanceId: "instance-id",
      stop: async () => {
        apiStopped = true;
      },
    }),
    createServer: async ({ runId, readiness }) => {
      for (const feature of ["prose", "diagram", "diff", "code-reference"])
        readiness.markRendered(feature);

      return {
        url: `http://127.0.0.1:5001/?review=review-id&run=${runId}`,
        origin: "http://127.0.0.1:5001",
        close: async () => {
          shellClosed = true;
          readiness.dispose();
        },
      };
    },
    launchHost: async (_host, url) => {
      assert.match(url, /review=review-id/);

      return fakeProcess;
    },
  });

  try {
    const ready = await host.start({
      runId: "run-1",
      profileDir,
      fixtureDir: "/tmp/fixture",
    });

    assert.deepEqual(ready, {
      protocolVersion: 1,
      serverPid: 101,
      url: "http://127.0.0.1:5001/?review=review-id&run=run-1",
      token: "review-token",
      instanceId: "instance-id",
    });
    await host.stop();
    assert.equal(processStopped, true);
    assert.equal(shellClosed, true);
    assert.equal(apiStopped, true);
  } finally {
    await rm(profileDir, { recursive: true, force: true });
  }
});
