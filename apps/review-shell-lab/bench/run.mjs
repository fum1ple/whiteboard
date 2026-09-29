#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const cliPath = path.join(appRoot, "src", "cli.mjs");

const hosts = ["electron", "tauri", "wails"];

const options = parseArgs(process.argv.slice(2));

if (process.platform !== "darwin")
  throw new Error("The local footprint collector currently requires macOS.");

await mkdir(path.dirname(options.output), { recursive: true });

const raw = {
  schemaVersion: 1,
  startedAt: new Date().toISOString(),
  machine: machineInfo(),
  fixture: options.fixture,
  reviewId: options.review,
  requestedRunsPerHost: options.runs,
  idleSeconds: options.idleSeconds,
  scenario: [
    "scroll-review-and-diagrams",
    "open-prose-code-reference",
    "open-diagram-code-reference",
    "select-changed-file",
    "run-review-cli",
  ],
  measurement:
    "macOS ps cumulative CPU time; footprint JSON before/after each CPU window",
  windowCondition: {
    required:
      "visible, foreground, and not minimized during idle and operation windows",
    verifiedByCollector:
      "attempted with System Events; runs record per-phase status",
  },
  fixtureIdentity: await fixtureIdentity(options.fixture, options.review),
  runs: [],
};

const order = runOrder(options.hosts, options.runs);

process.stdout.write(
  `Starting ${order.length} runs (${options.idleSeconds}s idle each).\n`,
);

for (const [index, host] of order.entries()) {
  const runNumber = raw.runs.filter((run) => run.host === host).length + 1;
  process.stdout.write(
    `${index + 1}/${order.length} ${host} run ${runNumber}/${options.runs}\n`,
  );
  raw.runs.push(await measureRun({ host, runNumber, options }));
  await writeFile(options.output, `${JSON.stringify(raw, null, 2)}\n`, {
    mode: 0o600,
  });
}

raw.completedAt = new Date().toISOString();

await writeFile(options.output, `${JSON.stringify(raw, null, 2)}\n`, {
  mode: 0o600,
});

async function measureRun({ host, runNumber, options: runOptions }) {
  const runId = `bench-${host}-${runNumber}-${randomUUID().slice(0, 8)}`;
  const profileDir = path.join(runOptions.profile, host, String(runNumber));

  const run = {
    host,
    runNumber,
    runId,
    startedAt: new Date().toISOString(),
    valid: false,
    processes: [],
    footprint: {},
  };

  let runner;
  let ready;
  let outputBuffer = "";
  let stderr = "";
  let sampler;
  let phase = "startup";
  let phaseCpu = { startup: 0, idle: 0, operation: 0 };
  let knownProcesses = new Map();
  let previousCpu = new Map();
  let currentProcesses = [];
  let webKitBaseline;
  let nativeHost;

  try {
    webKitBaseline = new Set(
      (await webKitHelpers()).map((helper) => helper.identity),
    );
    runner = spawn(
      process.execPath,
      [
        cliPath,
        "run",
        "--host",
        host,
        "--fixture",
        runOptions.fixture,
        "--review",
        runOptions.review,
        "--profile",
        profileDir,
      ],
      {
        cwd: path.resolve(appRoot, "../.."),
        env: { ...process.env, SHELL_LAB_BENCH: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    runner.stdout.setEncoding("utf8");
    runner.stderr.setEncoding("utf8");
    runner.stdout.on("data", (chunk) => {
      outputBuffer += chunk;
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("{")) continue;

        try {
          const event = JSON.parse(line);

          if (event.event === "shell-lab.ready") ready = event;
        } catch {
          // Human-readable runner messages are not readiness events.
        }
      }
    });
    runner.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });

    const startupStart = performance.now();
    await waitFor(
      () => ready || runner.exitCode !== null,
      120_000,
      "host render readiness",
    );

    if (!ready)
      throw new Error(`Host exited before readiness: ${safeError(stderr)}`);
    run.startupMs = performance.now() - startupStart;
    run.readyAt = new Date().toISOString();
    run.serverPid = ready.serverPid;
    run.instanceId = ready.instanceId;
    delete ready.token;
    delete ready.profileDir;
    delete ready.fixtureDir;
    run.ready = ready;

    const shellStateResponse = await fetch(new URL("/__state", ready.url));
    const shellState = await shellStateResponse.json();

    run.shellState = shellState;

    if (!shellStateResponse.ok || shellState.bench !== true)
      throw new Error("Shared UI did not enable benchmark interactions.");

    const reviewContent = await reviewContentIdentity(
      ready.url,
      runOptions.review,
    );

    run.reviewContent = reviewContent;

    if (!raw.fixtureIdentity.contentSha256) {
      raw.fixtureIdentity.contentSha256 = reviewContent.contentSha256;
      raw.fixtureIdentity.counts = reviewContent.counts;
    } else if (
      raw.fixtureIdentity.contentSha256 !== reviewContent.contentSha256
    ) {
      throw new Error("Review content hash changed between measurement runs.");
    }

    run.processes = await processSnapshot(runner.pid);

    if (!run.processes.some((entry) => entry.pid === run.serverPid))
      throw new Error(
        "Review API PID is outside the tracked host process tree.",
      );

    nativeHost = run.processes.find((entry) =>
      isHostExecutable(host, entry.executable),
    );

    if (!nativeHost)
      throw new Error(
        "Native host process is outside the tracked process tree.",
      );
    run.nativeHostPid = nativeHost.pid;
    run.hostCoalition = await resourceCoalition(nativeHost.pid);

    if (!run.hostCoalition)
      throw new Error("Could not read the native host resource coalition.");
    await checkWindowState("ready");
    await validateWebKitHelpers();

    phase = "idle";
    await checkWindowState("idleStart");
    await takeSample();
    await validateWebKitHelpers();
    sampler = setInterval(
      () =>
        takeSample().catch((error) => {
          run.sampleError = safeError(error.message);
        }),
      1_000,
    );
    sampler.unref?.();
    run.footprint.ready = await footprintSnapshot(
      currentProcesses.map((entry) => entry.pid),
    );
    await delay(runOptions.idleSeconds * 1_000);
    await checkWindowState("idleEnd");
    await takeSample();
    await validateWebKitHelpers();
    run.idleCpuSeconds = phaseCpu.idle;
    run.footprint.idle = await footprintSnapshot(
      currentProcesses.map((entry) => entry.pid),
    );
    await takeSample();

    phase = "operation";
    await checkWindowState("operationStart");
    phaseCpu.operation = 0;
    await takeSample();

    const startResponse = await fetch(new URL("/__bench", ready.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "start" }),
    });

    if (!startResponse.ok)
      throw new Error(
        `Shared UI did not accept the benchmark start command (${startResponse.status}).`,
      );

    let lastBenchState;

    let scenario;

    try {
      scenario = await waitFor(
        async () => {
          const response = await fetch(new URL("/__bench", ready.url));
          const result = await response.json();
          lastBenchState = result;

          return ["complete", "failed"].includes(result.state) ? result : null;
        },
        60_000,
        "shared UI interaction scenario",
      );
    } catch (error) {
      throw new Error(
        `${error.message} Last state: ${JSON.stringify(lastBenchState)}`,
      );
    }

    await takeSample();
    phase = "complete";

    if (scenario.state !== "complete")
      throw new Error(
        `UI scenario failed: ${scenario.error ?? "unknown failure"}`,
      );
    run.scenario = scenario;
    run.operationCpuSeconds = phaseCpu.operation;
    await validateWebKitHelpers();
    run.footprint.operation = await footprintSnapshot(
      currentProcesses.map((entry) => entry.pid),
    );
    run.operationFootprintBytes = run.footprint.operation.totalBytes;
    run.idleFootprintBytes = run.footprint.idle.totalBytes;
    run.valid = !run.sampleError && !run.invalidReason;

    if (run.sampleError) run.invalidReason = run.sampleError;
  } catch (error) {
    run.invalidReason = safeError(
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (sampler) clearInterval(sampler);

    if (runner && runner.exitCode === null) {
      runner.kill("SIGINT");
      await waitFor(
        () => runner.exitCode !== null,
        15_000,
        "shell-lab shutdown",
      ).catch(() => {
        runner.kill("SIGKILL");
      });
    }

    await delay(2_000);
    const remaining = await processesByPids(run.processes).catch(() => []);

    const remainingByPid = new Map(
      remaining.map((entry) => [entry.pid, entry]),
    );

    run.residualProcesses = run.processes.filter((entry) => {
      const current = remainingByPid.get(entry.pid);

      return (
        current &&
        current.startedAt === entry.startedAt &&
        current.executable === entry.executable
      );
    });
    run.residualProcessCount = run.residualProcesses.length;

    if (run.residualProcessCount > 0) {
      run.valid = false;
      run.invalidReason ??=
        "Tracked host or WebKit helper processes remained after shutdown.";

      try {
        run.footprint.exit = await footprintSnapshot(
          run.residualProcesses.map((entry) => entry.pid),
        );
      } catch (error) {
        run.valid = false;
        run.invalidReason = `Exit footprint unavailable: ${safeError(error.message)}`;
      }
    } else run.footprint.exit = { totalBytes: 0, processes: [] };
    run.finishedAt = new Date().toISOString();
  }

  return run;

  async function validateWebKitHelpers() {
    if (host === "electron") {
      run.webKitHelpers = [];
      run.systemWebKitHelpers = [];
      run.attributionComplete = true;

      return;
    }

    const helpers = await webKitHelpers();

    const hostProcesses = new Set(
      run.processes
        .filter((entry) => isHostExecutable(host, entry.executable))
        .map((entry) => entry.pid),
    );

    const hostTree = new Set(hostProcesses);
    let grew = true;

    while (grew) {
      grew = false;

      for (const entry of run.processes) {
        if (hostTree.has(entry.parentPid) && !hostTree.has(entry.pid)) {
          hostTree.add(entry.pid);
          grew = true;
        }
      }
    }

    const owned = helpers.filter(
      (helper) =>
        (!webKitBaseline.has(helper.identity) &&
          helper.coalition?.id === run.hostCoalition.id &&
          Date.parse(helper.startedAt) >= Date.parse(nativeHost.startedAt)) ||
        hostTree.has(helper.parentPid),
    );

    const newHelpers = helpers.filter(
      (helper) => !webKitBaseline.has(helper.identity),
    );

    const unknown = newHelpers.filter(
      (helper) => !helper.coalition && !hostTree.has(helper.parentPid),
    );

    const concurrentExternal = newHelpers.filter(
      (helper) =>
        helper.coalition?.id !== run.hostCoalition.id &&
        !hostTree.has(helper.parentPid),
    );

    run.webKitHelpers = owned.map(({ identity, ...helper }) => helper);
    run.systemWebKitHelpers = helpers
      .filter((helper) => !owned.includes(helper))
      .map(({ identity, ...helper }) => helper);

    if (!owned.length) {
      run.invalidReason = "No WebKit helper matched the native host coalition.";
      run.attributionComplete = false;
    } else if (unknown.length) {
      run.invalidReason = `WebKit helper ownership is unknown for PID(s): ${unknown.map((helper) => helper.pid).join(", ")}.`;
      run.attributionComplete = false;
    } else if (concurrentExternal.length) {
      run.invalidReason = `A different WebKit coalition started during the run (PID(s): ${concurrentExternal.map((helper) => helper.pid).join(", ")}).`;
      run.attributionComplete = false;
    } else run.attributionComplete = true;
  }

  async function takeSample() {
    const processes = await processSnapshot(
      runner.pid,
      (run.webKitHelpers ?? []).map((helper) => helper.pid),
    );

    currentProcesses = processes;

    for (const entry of processes) {
      const identity = `${entry.pid}:${entry.startedAt}:${entry.executable}`;
      knownProcesses.set(identity, entry);
      const last = previousCpu.get(identity);

      if (last !== undefined && entry.cpuSeconds >= last)
        phaseCpu[phase] += entry.cpuSeconds - last;
      previousCpu.set(identity, entry.cpuSeconds);
    }

    run.processes = [...knownProcesses.values()];
  }

  async function checkWindowState(phaseName) {
    const state = windowState(nativeHost.pid);

    run.windowStates ??= {};
    run.windowStates[phaseName] = state;

    if (
      state.verified &&
      (!state.frontmost ||
        !state.visible ||
        state.minimized ||
        state.width !== 1440 ||
        state.height !== 960)
    ) {
      run.invalidReason = `Native host window did not meet the visible 1440x960 foreground condition at ${phaseName}.`;
    }
  }
}

async function webKitHelpers() {
  const output = execFile("ps", ["-axo", "pid=,ppid=,time=,command="], {
    encoding: "utf8",
  });

  const helpers = [];

  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);

    if (
      !match ||
      !/com\.apple\.WebKit\.(?:WebContent|Networking|GPU|Plugin|Storage)/i.test(
        match[4],
      )
    )
      continue;

    const pid = Number(match[1]);
    const details = processDetails(pid);

    if (!details.startedAt || !details.executable) continue;
    helpers.push({
      identity: `${pid}:${details.startedAt}:${details.executable}`,
      pid,
      parentPid: Number(match[2]),
      startedAt: details.startedAt,
      executable: details.executable,
      name: path.basename(details.executable),
      cpuSeconds: parseCpuTime(match[3]),
      coalition: await resourceCoalition(pid),
    });
  }

  return helpers;
}

function isHostExecutable(host, executable) {
  const name = path.basename(executable).toLowerCase();

  if (host === "electron") return name === "whiteboardshelllabelectron";

  if (host === "tauri") return name === "whiteboard-shell-lab-tauri";

  return name === "whiteboardshelllabwails";
}

async function processSnapshot(rootPid, additionalPids = []) {
  if (!rootPid) return [];

  const output = execFile("ps", ["-axo", "pid=,ppid=,time=,command="], {
    encoding: "utf8",
  });

  const processes = output
    .split("\n")
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);

      if (!match) return null;

      return {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        cpuSeconds: parseCpuTime(match[3]),
        command: match[4],
        executable: match[4].split(/\s+/)[0],
      };
    })
    .filter(Boolean);

  const byPid = new Map(processes.map((entry) => [entry.pid, entry]));
  const selected = new Set([rootPid, ...additionalPids]);
  let grew = true;

  while (grew) {
    grew = false;

    for (const entry of processes) {
      if (selected.has(entry.parentPid) && !selected.has(entry.pid)) {
        selected.add(entry.pid);
        grew = true;
      }
    }
  }

  const records = [];

  for (const entry of processes.filter((candidate) =>
    selected.has(candidate.pid),
  )) {
    const details = processDetails(entry.pid);

    if (!details.startedAt || details.executable !== entry.executable) continue;
    records.push({ ...entry, ...details });
  }

  return records;
}

async function processesByPids(entries) {
  const live = [];

  for (const entry of entries) {
    const current = processDetails(entry.pid);

    if (
      current.startedAt &&
      current.startedAt === entry.startedAt &&
      current.executable === entry.executable
    )
      live.push({ ...entry, ...current });
  }

  return live;
}

function processDetails(pid) {
  const output = spawnSync(
    "ps",
    ["-p", String(pid), "-o", "lstart=,command="],
    { encoding: "utf8" },
  );

  if (output.status !== 0 || !output.stdout.trim())
    return { startedAt: "", command: "", executable: "" };
  const match = /^(.{24})\s+(.+)$/.exec(output.stdout.trim());

  if (!match) return { startedAt: "", command: "", executable: "" };

  return {
    startedAt: match[1].trim(),
    command: match[2],
    executable: match[2].split(/\s+/)[0],
  };
}

async function resourceCoalition(pid) {
  const result = spawnSync("launchctl", ["print", `pid/${pid}`], {
    encoding: "utf8",
    timeout: 5_000,
  });

  if (result.status !== 0) return null;

  const coalition = /resource coalition\s*=\s*\{([\s\S]*?)\n\s*\}/.exec(
    result.stdout,
  )?.[1];

  const id = /\bID\s*=\s*(\d+)/.exec(coalition ?? "")?.[1];

  if (!id) return null;
  const bundleId = /\bbundle ID\s*=\s*(.+)/.exec(coalition ?? "")?.[1];

  return { id: Number(id), bundleId: bundleId?.trim() ?? null };
}

function windowState(pid) {
  const script = [
    'tell application "System Events"',
    `set p to first application process whose unix id is ${pid}`,
    "set frontmost of p to true",
    "set f to frontmost of p",
    "set v to visible of p",
    'if (count of windows of p) is 0 then return (f as text) & "|" & (v as text) & "|missing"',
    "set w to window 1 of p",
    'set m to value of attribute "AXMinimized" of w',
    "set size of w to {1440, 960}",
    "delay 0.2",
    "set s to size of w",
    'return (f as text) & "|" & (v as text) & "|" & (m as text) & "|" & (item 1 of s as text) & "x" & (item 2 of s as text)',
    "end tell",
  ].join("\n");

  const result = spawnSync("osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 5_000,
  });

  if (result.status !== 0)
    return { verified: false, reason: safeError(result.stderr.trim()) };
  const [frontmost, visible, minimized, size] = result.stdout.trim().split("|");
  const [width, height] = (size ?? "").split("x").map(Number);

  if (!Number.isFinite(width) || !Number.isFinite(height))
    return {
      verified: false,
      reason: "System Events did not return window dimensions.",
    };

  return {
    verified: true,
    frontmost: frontmost === "true",
    visible: visible === "true",
    minimized: minimized === "true",
    width,
    height,
  };
}

async function footprintSnapshot(pids) {
  if (!pids.length)
    throw new Error(
      "No tracked processes were available for footprint measurement.",
    );
  const dir = await mkdtemp(path.join(os.tmpdir(), "shell-lab-footprint-"));
  const outputPath = path.join(dir, "footprint.json");

  try {
    const args = ["-j", outputPath, "-f", "bytes"];

    for (const pid of pids) args.push("-p", String(pid));
    execFile("footprint", args, { encoding: "utf8", timeout: 30_000 });
    const data = JSON.parse(await readFile(outputPath, "utf8"));

    if (data.errors?.length || data.warnings?.length)
      throw new Error(
        `footprint reported errors or warnings: ${JSON.stringify({ errors: data.errors, warnings: data.warnings })}`,
      );

    const found = new Map(
      (data.processes ?? []).map((process) => [Number(process.pid), process]),
    );

    const missing = pids.filter((pid) => !found.has(pid));

    if (missing.length)
      throw new Error(
        `footprint omitted tracked PID(s): ${missing.join(", ")}`,
      );

    const processes = pids.map((pid) => {
      const process = found.get(pid);

      if (!Number.isFinite(process.footprint))
        throw new Error(`footprint has no byte count for PID ${pid}.`);

      return { pid, name: process.name, footprintBytes: process.footprint };
    });

    return {
      totalBytes: processes.reduce(
        (sum, process) => sum + process.footprintBytes,
        0,
      ),
      processes,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function fixtureIdentity(fixture, reviewId) {
  const fixtureDir = path.join(appRoot, "fixtures", fixture);
  const manifest = await readFile(path.join(fixtureDir, "manifest.json"));
  const parsed = JSON.parse(manifest);

  if (parsed.reviewId !== reviewId)
    throw new Error("Review id does not match fixture manifest.");
  const hash = (data) => createHash("sha256").update(data).digest("hex");

  return {
    manifestSha256: hash(manifest),
    baseSha: parsed.baseSha,
    headSha: parsed.headSha,
    reviewId: parsed.reviewId,
    contentSha256: null,
    changedFileCount: fixture === "small" ? 1 : fixture === "medium" ? 6 : 30,
  };
}

async function reviewContentIdentity(shellUrl, reviewId) {
  const shellOrigin = new URL(shellUrl).origin;

  const request = async (route) => {
    const response = await fetch(
      new URL(
        `/reviews-api/${encodeURIComponent(reviewId)}${route}`,
        shellOrigin,
      ),
    );

    if (!response.ok)
      throw new Error(
        `Could not hash review content (${response.status}): ${route}`,
      );

    return response;
  };

  const snapshot = await (await request("?full=true")).json();
  const files = await (await request("/diff?format=files")).json();
  const patches = [];

  for (const file of files) {
    const query = new URLSearchParams({ paths: file.path, format: "patch" });
    patches.push([file.path, await (await request(`/diff?${query}`)).text()]);
  }

  const references = [];

  for (const block of snapshot.document ?? []) {
    if (block.type === "markdown") {
      for (const match of block.markdown.matchAll(
        /review-source:(head|base)\/([^#)\s]+)#L(\d+)(?:-L(\d+))?/g,
      ))
        references.push({
          side: match[1],
          file: decodeURIComponent(match[2]),
          start: Number(match[3]),
          end: Number(match[4] ?? match[3]),
        });
    }

    if (block.type === "flow_diagram")
      for (const node of block.nodes ?? [])
        for (const attachment of node.attachments ?? [])
          for (const source of attachment.sources ?? [])
            references.push(referenceFromSource(source));

    if (block.type === "sequence")
      for (const step of block.steps ?? [])
        if (step.source) references.push(referenceFromSource(step.source));
  }

  const uniqueReferences = [
    ...new Map(
      references.map((reference) => [JSON.stringify(reference), reference]),
    ).values(),
  ];

  const sourceContents = [];

  for (const reference of uniqueReferences) {
    const query = new URLSearchParams({
      side: reference.side,
      file: reference.file,
    });

    const result = await (await request(`/file?${query}`)).json();
    sourceContents.push([reference, result.text]);
  }

  const canonical = JSON.stringify({
    snapshot,
    files,
    patches,
    sourceContents,
  });

  return {
    contentSha256: createHash("sha256").update(canonical).digest("hex"),
    counts: {
      proseBlocks: (snapshot.document ?? []).filter(
        (block) => block.type === "markdown",
      ).length,
      diagramBlocks: (snapshot.document ?? []).filter((block) =>
        ["flow_diagram", "sequence"].includes(block.type),
      ).length,
      changedFiles: files.length,
      sourceReferences: uniqueReferences.length,
    },
  };
}

function referenceFromSource(source) {
  return {
    side: source.start.side,
    file: source.file,
    start: source.start.line,
    end: source.end?.line ?? source.start.line,
  };
}

function runOrder(selectedHosts, runs) {
  const result = [];

  for (let round = 0; round < runs; round += 1) {
    const offset = round % selectedHosts.length;

    const rotated = [
      ...selectedHosts.slice(offset),
      ...selectedHosts.slice(0, offset),
    ];

    if (round % 2) rotated.reverse();
    result.push(...rotated);
  }

  return result;
}

function parseArgs(args) {
  const values = new Map();

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];

    if (!key?.startsWith("--") || value === undefined)
      throw new Error(`Invalid benchmark argument: ${key ?? ""}`);
    values.set(key, value);
  }

  const selectedHosts = (values.get("--hosts") ?? hosts.join(",")).split(",");

  if (
    selectedHosts.some((host) => !hosts.includes(host)) ||
    new Set(selectedHosts).size !== selectedHosts.length
  )
    throw new Error(
      "--hosts must contain unique electron, tauri, and/or wails values.",
    );
  const fixture = values.get("--fixture");
  const review = values.get("--review");

  if (!["small", "medium", "large"].includes(fixture) || !review)
    throw new Error("Specify --fixture and --review.");

  const profile = path.resolve(
    values.get("--profile") ?? path.join(appRoot, "bench-profiles"),
  );

  const output = path.resolve(
    values.get("--output") ??
      path.join(appRoot, "bench-results", `shell-lab-${Date.now()}.json`),
  );

  const runs = Number(values.get("--runs") ?? "5");
  const idleSeconds = Number(values.get("--idle-seconds") ?? "60");

  if (
    !Number.isInteger(runs) ||
    runs < 1 ||
    !Number.isInteger(idleSeconds) ||
    idleSeconds < 1
  )
    throw new Error("--runs and --idle-seconds must be positive integers.");

  return {
    fixture,
    review,
    profile,
    output,
    runs,
    idleSeconds,
    hosts: selectedHosts,
  };
}

function machineInfo() {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    model: command("sysctl", ["-n", "hw.model"]),
    chip: command("sysctl", ["-n", "machdep.cpu.brand_string"]),
    memoryBytes: os.totalmem(),
    macOS: command("sw_vers", ["-productVersion"]),
  };
}

function parseCpuTime(value) {
  const parts = value.split(":");
  const seconds = Number(parts.pop());
  const minutes = Number(parts.pop() ?? 0);
  const hours = Number(parts.pop() ?? 0);

  return hours * 3_600 + minutes * 60 + seconds;
}

function command(file, args) {
  return execFile(file, args, { encoding: "utf8" }).trim();
}

function execFile(file, args, options) {
  const result = spawnSync(file, args, { ...options, encoding: "utf8" });

  if (result.status !== 0)
    throw new Error(
      `${file} failed (${result.status}): ${safeError(result.stderr || result.error?.message || "unknown error")}`,
    );

  return result.stdout ?? "";
}

async function waitFor(predicate, timeoutMs, description) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await predicate();

    if (result) return result;
    await delay(100);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

function delay(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function safeError(value) {
  return String(value).replace(
    /("?token"?\s*[:=]\s*)[^\s,}]+/gi,
    "$1[redacted]",
  );
}
