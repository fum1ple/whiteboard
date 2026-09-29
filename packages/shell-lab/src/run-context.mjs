import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const fixtureNames = new Set(["small", "medium", "large"]);

export async function createRunContext({ runId, profileDir, fixture }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(runId))
    throw new Error("runId must contain 1 to 64 safe path characters.");
  if (!fixtureNames.has(fixture)) throw new Error(`Unknown fixture: ${fixture}`);

  const root = path.resolve(profileDir);
  const runProfile = path.join(root, runId);
  const fixtureDir = path.resolve(
    path.dirname(root),
    "fixtures",
    fixture,
  );
  await mkdir(runProfile, { recursive: true, mode: 0o700 });
  await writeFile(path.join(runProfile, ".shell-lab-run"), `${runId}\n`, {
    flag: "wx",
    mode: 0o600,
  }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });

  return { runId, profileDir: runProfile, fixture, fixtureDir };
}
