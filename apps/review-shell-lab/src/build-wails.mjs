import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const hostRoot = path.join(appRoot, "hosts", "wails");

const executable = process.platform === "win32" ? "wails.exe" : "wails";

const version = spawnSync(executable, ["version"], { encoding: "utf8" });

if (
  version.status !== 0 ||
  !/v2\.15\.0/.test(`${version.stdout}\n${version.stderr}`)
) {
  process.stderr.write(
    "Install the Wails v2.15.0 CLI before building this host.\n",
  );
  process.exit(1);
}

const child = spawn(executable, ["build", "-clean"], {
  cwd: hostRoot,
  env: {
    ...process.env,
    WHITEBOARD_SHELL_LAB_URL: "http://127.0.0.1:4321",
    WHITEBOARD_SHELL_LAB_PROFILE_DIR: path.join(
      os.tmpdir(),
      "wbsl-build-placeholder",
    ),
  },
  stdio: "inherit",
});

child.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
