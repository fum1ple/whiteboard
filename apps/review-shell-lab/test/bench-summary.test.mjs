import assert from "node:assert/strict";
import test from "node:test";

import { summarizeRuns } from "../bench/summarize.mjs";

test("summary uses valid runs only and reports median plus full range", () => {
  const raw = {
    schemaVersion: 1,
    requestedRunsPerHost: 2,
    runs: [
      {
        host: "electron",
        valid: true,
        startupMs: 100,
        idleCpuSeconds: 4,
        idleFootprintBytes: 400,
        operationCpuSeconds: 2,
        operationFootprintBytes: 500,
        residualProcessCount: 0,
      },
      {
        host: "electron",
        valid: true,
        startupMs: 200,
        idleCpuSeconds: 6,
        idleFootprintBytes: 600,
        operationCpuSeconds: 4,
        operationFootprintBytes: 700,
        residualProcessCount: 0,
      },
      {
        host: "tauri",
        valid: true,
        startupMs: 50,
        idleCpuSeconds: 2,
        idleFootprintBytes: 200,
        operationCpuSeconds: 1,
        operationFootprintBytes: 300,
        residualProcessCount: 0,
      },
      { host: "tauri", valid: false, invalidReason: "footprint warning" },
    ],
  };

  assert.deepEqual(summarizeRuns(raw).hosts, {
    electron: {
      validRuns: 2,
      requestedRuns: 2,
      startupMs: { median: 150, min: 100, max: 200 },
      idleCpuSeconds: { median: 5, min: 4, max: 6 },
      idleFootprintBytes: { median: 500, min: 400, max: 600 },
      operationCpuSeconds: { median: 3, min: 2, max: 4 },
      operationFootprintBytes: { median: 600, min: 500, max: 700 },
      residualProcessCount: { median: 0, min: 0, max: 0 },
    },
    tauri: { validRuns: 1, requestedRuns: 2, incomplete: true },
  });
});
