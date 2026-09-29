import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const workspaceRoot = path.resolve(appRoot, "../..");

const reviewRoot = path.join(workspaceRoot, "packages", "review");

export async function startReviewApi(profileDir, options = {}) {
  const discoveryPath = path.join(profileDir, "review-server", "server.json");
  const cliPath = options.cliPath ?? path.join(reviewRoot, "dist", "cli.js");
  const sourcePath = path.join(reviewRoot, "src", "cli.ts");
  const tsxPath = path.join(reviewRoot, "node_modules", ".bin", "tsx");
  const hasCli = await exists(cliPath);
  const executable = hasCli ? process.execPath : tsxPath;
  const entry = hasCli ? cliPath : sourcePath;

  if (!hasCli && !(await exists(tsxPath)))
    throw new Error(
      "Build @dev.fast/review or install workspace dependencies before running shell-lab.",
    );

  const child = spawn(
    executable,
    [
      entry,
      "--state-dir",
      profileDir,
      "server",
      "start",
      "--port",
      "0",
      "--json",
    ],
    {
      cwd: workspaceRoot,
      env: { ...process.env, DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  let startupError;

  const readyLine = new Promise((resolve, reject) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;

      for (;;) {
        const newline = stdout.indexOf("\n");

        if (newline < 0) break;
        const line = stdout.slice(0, newline);
        stdout = stdout.slice(newline + 1);

        try {
          const event = JSON.parse(line);

          if (event.event === "server.ready") resolve(event);
        } catch {
          // The server can emit human-readable diagnostics before readiness.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== 0 || !options.allowEarlyExit)
        reject(
          new Error(
            `Review API exited before readiness (code ${code ?? "none"}, signal ${signal ?? "none"}). ${stderr}`,
          ),
        );
    });
  });

  try {
    let startupTimer;

    const ready = await Promise.race([
      readyLine,
      new Promise((_, reject) => {
        startupTimer = setTimeout(
          () => reject(new Error(`Review API startup timed out. ${stderr}`)),
          options.timeoutMs ?? 60_000,
        );
      }),
    ]).finally(() => clearTimeout(startupTimer));

    const discovery = JSON.parse(await readFile(discoveryPath, "utf8"));

    if (ready.url !== discovery.url || ready.serverPid !== discovery.serverPid)
      throw new Error(
        "Review API readiness did not match its private discovery record.",
      );

    if (options.reviewId) {
      const review = await fetch(
        `${discovery.url}/reviews-api/${encodeURIComponent(options.reviewId)}?full=true`,
        {
          headers: { "x-review-token": discovery.token },
          signal: AbortSignal.timeout(10_000),
        },
      );

      if (!review.ok)
        throw new Error(
          `Review ${options.reviewId} is not available in the isolated fixture profile (${review.status}).`,
        );
      const snapshot = await review.json();

      if (
        snapshot.reviewId !== options.reviewId ||
        !Array.isArray(snapshot.document)
      )
        throw new Error(
          `Review ${options.reviewId} returned an invalid full snapshot.`,
        );
    }

    return {
      url: discovery.url,
      token: discovery.token,
      serverPid: discovery.serverPid,
      instanceId: discovery.instanceId,
      stop: () => stopChild(child),
      child,
    };
  } catch (error) {
    await stopChild(child).catch(() => undefined);
    throw error;
  }
}

export async function runReviewCli(profileDir, reviewId, options = {}) {
  const cliPath = options.cliPath ?? path.join(reviewRoot, "dist", "cli.js");
  const hasCli = await exists(cliPath);
  const tsxPath = path.join(reviewRoot, "node_modules", ".bin", "tsx");
  const executable = hasCli ? process.execPath : tsxPath;
  const entry = hasCli ? cliPath : path.join(reviewRoot, "src", "cli.ts");

  if (!hasCli && !(await exists(tsxPath)))
    throw new Error(
      "Build @dev.fast/review or install workspace dependencies before running shell-lab.",
    );

  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        entry,
        "--state-dir",
        profileDir,
        "api",
        "review_get",
        JSON.stringify({ reviewId, full: true }),
      ],
      {
        cwd: workspaceRoot,
        env: { ...process.env, DEV_FAST_REVIEW_CLI_NO_DELEGATE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Whiteboard CLI query timed out."));
    }, options.timeoutMs ?? 30_000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-1_000_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-8_000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);

      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `Whiteboard CLI exited (code ${code ?? "none"}, signal ${signal ?? "none"}). ${stderr}`,
          ),
        );
    });
  });
}

async function exists(file) {
  try {
    await access(file);

    return true;
  } catch {
    return false;
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
  force.unref?.();
  await exited;
  clearTimeout(force);
}
