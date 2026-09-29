import { spawnSync } from "node:child_process";
import { access, copyFile, readFile, stat } from "node:fs/promises";
import path from "node:path";

export async function copyFixtureProfile({
  fixtureDir,
  profileDir,
  fixture,
  reviewId,
  verifyGit = true,
}) {
  const manifestPath = path.join(fixtureDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

  if (manifest.version !== 1 || manifest.fixture !== fixture)
    throw new Error(`Fixture manifest does not describe ${fixture}.`);

  if (manifest.reviewId !== reviewId)
    throw new Error(
      `Review id ${reviewId} does not match the ${fixture} fixture manifest (${manifest.reviewId}).`,
    );

  if (
    !manifest.repository ||
    !/^[a-f\d]{40}$/i.test(manifest.baseSha) ||
    !/^[a-f\d]{40}$/i.test(manifest.headSha)
  )
    throw new Error(`Fixture manifest for ${fixture} is incomplete.`);

  if (
    path.resolve(fixtureDir, manifest.repository) !==
    path.resolve(fixtureDir, "repo")
  )
    throw new Error(
      `Fixture manifest for ${fixture} points outside its fixture repository.`,
    );

  if (verifyGit) await verifyRepository(fixtureDir, manifest);

  const sourceProfile = path.join(fixtureDir, "profile");
  const sourceDatabase = path.join(sourceProfile, "review-api.db");
  const targetDatabase = path.join(profileDir, "review-api.db");
  await access(sourceDatabase);

  for (const suffix of ["-wal", "-shm"]) {
    try {
      if ((await stat(`${sourceDatabase}${suffix}`)).size > 0)
        throw new Error(
          `Fixture profile has a non-empty SQLite ${suffix} file; stop the seed server before copying.`,
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  try {
    await access(targetDatabase);
    throw new Error(
      `Run profile already contains a Review database: ${profileDir}`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  await copyFile(sourceDatabase, targetDatabase);

  return manifest;
}

async function verifyRepository(fixtureDir, manifest) {
  const repository = path.resolve(fixtureDir, manifest.repository);

  for (const [revision, expected] of [
    ["base", manifest.baseSha],
    ["head", manifest.headSha],
  ]) {
    const actual = git(repository, "rev-parse", `refs/shell-lab/${revision}`);

    if (actual !== expected)
      throw new Error(
        `${manifest.fixture} fixture ${revision} revision differs from its manifest.`,
      );
  }
}

function git(directory, ...args) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
  });

  if (result.status !== 0)
    throw new Error(
      `Could not verify fixture repository: ${result.stderr.trim()}`,
    );

  return result.stdout.trim();
}
