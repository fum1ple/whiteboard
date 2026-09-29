import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { copyFixtureProfile } from "./fixture-profile.mjs";
import { createReadyGate } from "./ready-gate.mjs";
import { runReviewCli, startReviewApi } from "./review-api-process.mjs";
import { createRunContext } from "./run-context.mjs";
import { createShellServer } from "./shell-server.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export function createHost(hostName, configuration) {
  let api;
  let shell;
  let hostProcess;
  let readiness;
  let stopped = false;
  let hostClosed = Promise.resolve();

  return {
    async start({ runId, profileDir, fixtureDir }) {
      if (api || shell || hostProcess)
        throw new Error("Host is already started.");

      if (!runId || !profileDir || !fixtureDir)
        throw new Error("runId, profileDir, and fixtureDir are required.");
      await mkdir(profileDir, { recursive: true, mode: 0o700 });
      readiness = createReadyGate({
        runId,
        timeoutMs: configuration.readyTimeoutMs,
      });

      try {
        await (configuration.copyProfile ?? copyFixtureProfile)({
          fixtureDir,
          profileDir,
          fixture: configuration.fixture,
          reviewId: configuration.reviewId,
        });
        api = await (configuration.startApi ?? startReviewApi)(
          profileDir,
          configuration,
        );
        shell = await (configuration.createServer ?? createShellServer)({
          runId,
          reviewId: configuration.reviewId,
          fixture: configuration.fixture,
          apiUrl: api.url,
          apiToken: api.token,
          apiPid: api.serverPid,
          instanceId: api.instanceId,
          readiness,
          bench: configuration.bench === true,
          cli: (reviewId) => runReviewCli(profileDir, reviewId, configuration),
        });
        hostProcess = await (configuration.launchHost ?? launchNativeHost)(
          hostName,
          shell.url,
          configuration,
        );
        hostClosed = new Promise((resolve) =>
          hostProcess.once("exit", resolve),
        );

        const processExit = new Promise((_, reject) => {
          hostProcess.once("error", reject);
          hostProcess.once("exit", (code, signal) => {
            if (!stopped)
              reject(
                new Error(
                  `${hostName} closed before the review rendered (code ${code ?? "none"}, signal ${signal ?? "none"}).`,
                ),
              );
          });
        });

        await Promise.race([readiness.wait(), processExit]);

        return {
          protocolVersion: 1,
          serverPid: api.serverPid,
          url: shell.url,
          token: api.token,
          instanceId: api.instanceId,
        };
      } catch (error) {
        await this.stop().catch(() => undefined);
        throw error;
      }
    },

    waitForClose() {
      return hostClosed;
    },

    async stop() {
      if (stopped) return;
      stopped = true;
      readiness?.dispose();

      if (hostProcess) await stopProcess(hostProcess);

      if (shell) await shell.close();

      if (api) await api.stop();

      if (hostProcess?.shellLabProfileDir)
        await rm(hostProcess.shellLabProfileDir, {
          recursive: true,
          force: true,
        });
      api = undefined;
      shell = undefined;
      hostProcess = undefined;
    },
  };
}

export async function runShellLab({ host, fixture, reviewId, profileDir }) {
  const runId = randomUUID();
  let context;
  let adapter;
  let resolveSignal;

  const signal = new Promise((resolve) => {
    resolveSignal = resolve;
  });

  const onSignal = () => resolveSignal();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    context = await createRunContext({
      runId,
      profileDir,
      fixture,
      fixtureRoot: path.join(appRoot, "fixtures"),
    });
    adapter = createHost(host, {
      fixture,
      reviewId,
      bench: process.env.SHELL_LAB_BENCH === "1",
      runId: context.runId,
    });

    const ready = await adapter.start({
      runId: context.runId,
      profileDir: context.profileDir,
      fixtureDir: context.fixtureDir,
    });

    process.stdout.write(
      `${JSON.stringify({ event: "shell-lab.ready", ...ready, profileDir: context.profileDir, fixtureDir: context.fixtureDir })}\n`,
    );
    process.stdout.write("Press Ctrl-C to stop this comparison run.\n");
    await Promise.race([signal, adapter.waitForClose()]);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await adapter?.stop();

    if (context) await rm(context.profileDir, { recursive: true, force: true });
  }
}

async function launchNativeHost(hostName, url, configuration) {
  const profileRoot =
    process.platform === "darwin" ? "/private/tmp" : os.tmpdir();

  const hostProfileDir = path.join(profileRoot, `wbsl-${configuration.runId}`);
  await mkdir(hostProfileDir, { recursive: true, mode: 0o700 });

  const env = {
    ...process.env,
    WHITEBOARD_SHELL_LAB_URL: url,
    WHITEBOARD_SHELL_LAB_PROFILE_DIR: hostProfileDir,
  };

  if (hostName === "electron") {
    const executable =
      configuration.electronPath ?? packagedExecutable(hostName);

    const child = spawn(executable, [url], {
      cwd: appRoot,
      stdio: "ignore",
      env,
    });

    child.shellLabProfileDir = hostProfileDir;

    return child;
  }

  if (hostName === "tauri") {
    const executable = configuration.tauriPath ?? packagedExecutable(hostName);

    const child = spawn(executable, [], {
      cwd: path.join(appRoot, "hosts", "tauri"),
      stdio: "ignore",
      env,
    });

    child.shellLabProfileDir = hostProfileDir;

    return child;
  }

  if (hostName === "wails") {
    const executable = configuration.wailsPath ?? packagedExecutable(hostName);

    const child = spawn(executable, [], {
      cwd: appRoot,
      stdio: "ignore",
      env,
    });

    child.shellLabProfileDir = hostProfileDir;

    return child;
  }

  throw new Error(`Unknown desktop host: ${hostName}`);
}

function packagedExecutable(hostName) {
  const platform = process.platform;

  const executableName =
    hostName === "tauri"
      ? "whiteboard-shell-lab-tauri"
      : "WhiteboardShellLabWails";

  const extension = platform === "win32" ? ".exe" : "";

  if (hostName === "electron") {
    const packaged = path.join(
      appRoot,
      "dist",
      "electron",
      `WhiteboardShellLabElectron-${platform}-${process.arch}`,
    );

    if (platform === "darwin")
      return path.join(
        packaged,
        "WhiteboardShellLabElectron.app",
        "Contents",
        "MacOS",
        "WhiteboardShellLabElectron",
      );

    return path.join(packaged, `WhiteboardShellLabElectron${extension}`);
  }

  if (hostName === "tauri")
    return path.join(
      appRoot,
      "hosts",
      "tauri",
      "target",
      "release",
      `${executableName}${extension}`,
    );

  if (platform === "darwin")
    return path.join(
      appRoot,
      "hosts",
      "wails",
      "build",
      "bin",
      "WhiteboardShellLabWails.app",
      "Contents",
      "MacOS",
      "WhiteboardShellLabWails",
    );

  return path.join(
    appRoot,
    "hosts",
    "wails",
    "build",
    "bin",
    `${executableName}${extension}`,
  );
}

async function stopProcess(child) {
  if (child.pid === undefined) return;

  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
  force.unref?.();
  await exited;
  clearTimeout(force);
}
