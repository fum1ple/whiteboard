import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { copyFixtureProfile } from "../src/fixture-profile.mjs";

test("fixture profile copies a stopped seed database into a run-specific profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shell-fixture-profile-"));
  const fixtureDir = path.join(root, "fixtures", "small");
  const profileDir = path.join(root, "profiles", "run-1");
  await mkdir(path.join(fixtureDir, "profile"), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(fixtureDir, "profile", "review-api.db"),
    "seed database",
  );
  await writeFile(
    path.join(fixtureDir, "manifest.json"),
    JSON.stringify({
      version: 1,
      fixture: "small",
      reviewId: "review-123",
      repository: "repo",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    }),
  );

  try {
    const manifest = await copyFixtureProfile({
      fixtureDir,
      profileDir,
      fixture: "small",
      reviewId: "review-123",
      verifyGit: false,
    });

    assert.equal(manifest.reviewId, "review-123");
    assert.equal(
      await readFile(path.join(profileDir, "review-api.db"), "utf8"),
      "seed database",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fixture profile rejects a mismatched review id and preserves the run profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shell-fixture-profile-"));
  const fixtureDir = path.join(root, "fixtures", "small");
  const profileDir = path.join(root, "profiles", "run-2");
  await mkdir(path.join(fixtureDir, "profile"), { recursive: true });
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(fixtureDir, "profile", "review-api.db"),
    "seed database",
  );
  await writeFile(
    path.join(fixtureDir, "manifest.json"),
    JSON.stringify({
      version: 1,
      fixture: "small",
      reviewId: "review-123",
      repository: "repo",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
    }),
  );

  try {
    await assert.rejects(
      copyFixtureProfile({
        fixtureDir,
        profileDir,
        fixture: "small",
        reviewId: "review-other",
        verifyGit: false,
      }),
      /does not match/,
    );
    await assert.rejects(readFile(path.join(profileDir, "review-api.db")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
