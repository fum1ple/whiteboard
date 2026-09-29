import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { existingFixtureIsUsable } from "../src/prepare-fixtures.mjs";

test("fixture reuse requires the declared git refs and a stopped seed database", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shell-fixture-health-"));
  const fixtureDir = path.join(root, "medium");
  const repositoryDir = path.join(fixtureDir, "repo");
  const profileDir = path.join(fixtureDir, "profile");
  await mkdir(repositoryDir, { recursive: true });
  await mkdir(profileDir, { recursive: true });

  try {
    execFileSync("git", ["init", "-b", "main", repositoryDir], {
      stdio: "ignore",
    });
    execFileSync("git", [
      "-C",
      repositoryDir,
      "config",
      "user.name",
      "Fixture Test",
    ]);
    execFileSync("git", [
      "-C",
      repositoryDir,
      "config",
      "user.email",
      "fixture@example.test",
    ]);
    await writeFile(
      path.join(repositoryDir, "file.ts"),
      "export const value = true;\n",
    );
    execFileSync("git", ["-C", repositoryDir, "add", "."]);
    execFileSync("git", ["-C", repositoryDir, "commit", "-m", "fixture"], {
      stdio: "ignore",
    });

    const baseSha = execFileSync(
      "git",
      ["-C", repositoryDir, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();

    const headSha = execFileSync(
      "git",
      ["-C", repositoryDir, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    ).trim();

    execFileSync("git", [
      "-C",
      repositoryDir,
      "update-ref",
      "refs/shell-lab/base",
      baseSha,
    ]);
    execFileSync("git", [
      "-C",
      repositoryDir,
      "update-ref",
      "refs/shell-lab/head",
      headSha,
    ]);
    await writeFile(path.join(profileDir, "review-api.db"), "seed database");

    const manifest = {
      version: 1,
      fixture: "medium",
      reviewId: "stable-id",
      repository: "repo",
      baseSha,
      headSha,
    };

    const input = { fixtureDir, repositoryDir, profileDir, manifest };

    assert.equal(await existingFixtureIsUsable(input), true);
    await writeFile(path.join(profileDir, "review-api.db-wal"), "live write");
    assert.equal(await existingFixtureIsUsable(input), false);
    await rm(path.join(profileDir, "review-api.db-wal"));
    await rm(path.join(profileDir, "review-api.db"));
    assert.equal(await existingFixtureIsUsable(input), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
