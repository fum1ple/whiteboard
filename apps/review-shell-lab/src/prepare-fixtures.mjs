import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startReviewApi } from "./review-api-process.mjs";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const fixtureNames = ["small", "medium", "large"];

export async function prepareFixtures({ force = false } = {}) {
  for (const fixture of fixtureNames) await prepareFixture(fixture, { force });
}

async function prepareFixture(fixture, { force }) {
  const fixtureDir = path.join(appRoot, "fixtures", fixture);
  const repositoryDir = path.join(fixtureDir, "repo");
  const profileDir = path.join(fixtureDir, "profile");
  const manifestPath = path.join(fixtureDir, "manifest.json");

  if (!force) {
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

      if (
        manifest.fixture === fixture &&
        (await existingFixtureIsUsable({
          fixtureDir,
          repositoryDir,
          profileDir,
          manifest,
        }))
      ) {
        process.stdout.write(
          `${fixture}: ${manifest.reviewId} (${manifest.baseSha.slice(0, 12)}..${manifest.headSha.slice(0, 12)})\n`,
        );

        return manifest;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (await exists(path.join(profileDir, "review-server", "server.json")))
    throw new Error(
      `Cannot reseed ${fixture} while its Review API is running.`,
    );

  await rm(repositoryDir, { recursive: true, force: true });
  await rm(profileDir, { recursive: true, force: true });
  await mkdir(repositoryDir, { recursive: true });
  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const contents = fixtureSources(fixture);
  await writeFiles(repositoryDir, contents.base);
  git(repositoryDir, ["init", "-b", "main"]);
  git(repositoryDir, ["config", "user.name", "Whiteboard Fixture"]);
  git(repositoryDir, ["config", "user.email", "shell-lab@example.test"]);
  git(repositoryDir, ["add", "."]);
  git(repositoryDir, ["commit", "-m", "fixture base"], {
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  });
  const baseSha = git(repositoryDir, ["rev-parse", "HEAD"]);
  git(repositoryDir, ["update-ref", "refs/shell-lab/base", baseSha]);
  await writeFiles(repositoryDir, contents.head);
  git(repositoryDir, ["add", "."]);
  git(repositoryDir, ["commit", "-m", "apply payment validation"], {
    GIT_AUTHOR_DATE: "2026-01-02T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-02T00:00:00Z",
  });
  const headSha = git(repositoryDir, ["rev-parse", "HEAD"]);
  git(repositoryDir, ["update-ref", "refs/shell-lab/head", headSha]);

  const api = await startReviewApi(profileDir);
  let reviewId;

  try {
    const repository = await request(api, "/reviews-api/repositories", {
      method: "POST",
      body: { path: repositoryDir },
    });

    const pins = await request(api, "/reviews-api/pins", {
      method: "POST",
      body: { repositoryId: repository.id, base: baseSha, head: headSha },
    });

    const created = await request(api, "/reviews-api/commands", {
      method: "POST",
      body: {
        commandId: randomUUID(),
        operation: {
          type: "create",
          title: `${fixture[0].toUpperCase()}${fixture.slice(1)} fixture: checkout payment validation`,
          pins,
          open: false,
        },
      },
    });

    reviewId = created.reviewId;
    const blocks = fixtureDocument(fixture);

    for (const content of blocks) {
      await request(api, "/reviews-api/commands", {
        method: "POST",
        body: {
          commandId: randomUUID(),
          operation: {
            type: "edit",
            reviewId,
            edit: { type: "insert", content },
          },
        },
      });
    }

    await verifyFixtureReview(api, reviewId, fixture, contents.head);
  } finally {
    await api.stop();
  }

  const databasePath = path.join(profileDir, "review-api.db");
  await verifyStoppedProfile(profileDir);

  const manifest = {
    version: 1,
    fixture,
    reviewId,
    repository: "repo",
    repositoryPath: repositoryDir,
    baseSha,
    headSha,
    createdAt: new Date().toISOString(),
  };

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `${fixture}: ${reviewId} (${baseSha.slice(0, 12)}..${headSha.slice(0, 12)})\n`,
  );

  return manifest;
}

export async function existingFixtureIsUsable({
  fixtureDir,
  repositoryDir,
  profileDir,
  manifest,
}) {
  if (
    manifest.version !== 1 ||
    !manifest.reviewId ||
    manifest.repository !== "repo" ||
    !/^[a-f\d]{40}$/i.test(manifest.baseSha) ||
    !/^[a-f\d]{40}$/i.test(manifest.headSha)
  )
    return false;

  try {
    await access(repositoryDir);
    await verifyFixtureRepository(repositoryDir, manifest);
    await verifyStoppedProfile(profileDir);

    return (
      path.resolve(fixtureDir, manifest.repository) ===
      path.resolve(repositoryDir)
    );
  } catch (error) {
    if (error.code === "ENOENT") return false;

    if (/database is missing/.test(error.message)) return false;

    if (/still has a non-empty SQLite/.test(error.message)) return false;

    if (/Could not verify fixture repository/.test(error.message)) return false;

    if (/^git rev-parse refs\/shell-lab\//.test(error.message)) return false;
    throw error;
  }
}

function verifyFixtureRepository(repositoryDir, manifest) {
  for (const [revision, expected] of [
    ["base", manifest.baseSha],
    ["head", manifest.headSha],
  ]) {
    const actual = git(repositoryDir, [
      "rev-parse",
      `refs/shell-lab/${revision}`,
    ]);

    if (actual !== expected)
      throw new Error(`Fixture ${revision} ref differs from its manifest.`);
  }
}

async function exists(file) {
  try {
    await access(file);

    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function fixtureSources(fixture) {
  const count = fixture === "small" ? 1 : fixture === "medium" ? 6 : 30;

  const paymentBase = [
    "export type LineItem = { amount: number; quantity: number };",
    "",
    "export function calculateTotal(items: LineItem[]): number {",
    "  const subtotal = items.reduce((sum, item) => sum + item.amount * item.quantity, 0);",
    "  return subtotal;",
    "}",
    "",
    "export function authorize(total: number): boolean {",
    "  return total > 0;",
    "}",
  ].join("\n");

  const paymentHead = [
    "export type LineItem = { amount: number; quantity: number };",
    "",
    "export function calculateTotal(items: LineItem[]): number {",
    "  const invalid = items.some((item) => item.amount < 0 || item.quantity < 1);",
    '  if (invalid) throw new Error("Line items must have positive quantities and amounts.");',
    "  const subtotal = items.reduce((sum, item) => sum + item.amount * item.quantity, 0);",
    "  return Math.round(subtotal * 100) / 100;",
    "}",
    "",
    "export function authorize(total: number): boolean {",
    "  return Number.isFinite(total) && total > 0;",
    "}",
  ].join("\n");

  const base = { "src/payment.ts": paymentBase };
  const head = { "src/payment.ts": paymentHead };

  for (let index = 1; index < count; index += 1) {
    const file = `src/steps/${String(index).padStart(2, "0")}-stage.ts`;
    base[file] =
      `export function stage${index}(value: number): number {\n  return value + ${index};\n}\n`;
    head[file] =
      `export function stage${index}(value: number): number {\n  if (!Number.isFinite(value)) throw new Error("Invalid stage value");\n  return value + ${index};\n}\n`;
  }

  return { base, head };
}

function fixtureDocument(fixture) {
  const markdown = {
    type: "markdown",
    markdown: `## Payment validation\n\nCheckout now rejects invalid line items before authorization and rounds totals to cents. The [validation branch](review-source:head/src/payment.ts#L3-L7) reports the offending input, while the [base calculation](review-source:base/src/payment.ts#L3-L5) shows the earlier behavior.\n\nThe same rule is applied to ${fixture === "small" ? "one changed source file" : fixture === "medium" ? "six changed source files" : "thirty changed source files"}. The shared fixture keeps the review text and diagram constant so each desktop host renders identical content.`,
  };

  const flow = {
    type: "flow_diagram",
    title: "Checkout payment path",
    direction: "right",
    nodes: [
      { key: "cart", label: "Cart", kind: "terminal", attachments: [] },
      {
        key: "validate",
        label: "Validate items",
        kind: "process",
        attachments: [
          {
            label: "Validation code",
            sources: [
              {
                file: "src/payment.ts",
                start: { side: "head", line: 3 },
                end: { side: "head", line: 7 },
              },
            ],
          },
        ],
      },
      { key: "total", label: "Round total", kind: "process", attachments: [] },
      {
        key: "authorize",
        label: "Authorize",
        kind: "terminal",
        attachments: [],
      },
    ],
    edges: [
      { from: "cart", to: "validate", label: "items" },
      { from: "validate", to: "total", label: "valid" },
      { from: "total", to: "authorize", label: "amount" },
    ],
  };

  const sequence = {
    type: "sequence",
    title: "Request lifecycle",
    actors: {
      checkout: "Checkout",
      payments: "Payments API",
      ledger: "Ledger",
    },
    steps: [
      {
        from: "checkout",
        to: "payments",
        label: "submit items",
        style: "call",
        explanation: "Cart contents arrive for validation.",
      },
      {
        from: "payments",
        to: "payments",
        label: "calculate cents",
        style: "async",
        source: {
          file: "src/payment.ts",
          start: { side: "head", line: 4 },
          end: { side: "head", line: 7 },
        },
      },
      {
        from: "payments",
        to: "ledger",
        label: "authorize total",
        style: "call",
        explanation: "Only validated totals reach authorization.",
      },
    ],
  };

  return [markdown, flow, sequence];
}

async function verifyFixtureReview(api, reviewId, fixture, headFiles) {
  const snapshot = await request(api, `/reviews-api/${reviewId}?full=true`);

  if (
    snapshot.document.length !== 3 ||
    snapshot.document[0].type !== "markdown" ||
    snapshot.document[1].type !== "flow_diagram" ||
    snapshot.document[2].type !== "sequence"
  )
    throw new Error(
      `${fixture} fixture review does not contain prose and both diagrams.`,
    );

  const files = await request(
    api,
    `/reviews-api/${reviewId}/diff?format=files`,
  );

  if (files.length !== Object.keys(headFiles).length)
    throw new Error(
      `${fixture} fixture diff contains ${files.length} files; expected ${Object.keys(headFiles).length}.`,
    );

  const code = await request(
    api,
    `/reviews-api/${reviewId}/file?side=head&file=src/payment.ts`,
  );

  if (!code.text.includes("Line items must have positive quantities"))
    throw new Error(
      `${fixture} fixture code reference did not resolve against the head revision.`,
    );
}

async function request(api, route, { method = "GET", body } = {}) {
  const headers = { "x-review-token": api.token };
  const options = { method, headers };

  if (body) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${api.url}${route}`, {
    ...options,
  });

  const result = (response.headers.get("content-type") ?? "").includes(
    "application/json",
  )
    ? await response.json()
    : await response.text();

  if (!response.ok)
    throw new Error(
      `${method} ${route} failed (${response.status}): ${result.error ?? result}`,
    );

  return result;
}

async function writeFiles(root, files) {
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${contents}\n`);
  }
}

function git(directory, args, env = {}) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

  if (result.status !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);

  return result.stdout.trim();
}

async function verifyStoppedProfile(profileDir) {
  const entries = await readdir(profileDir);

  if (!entries.includes("review-api.db"))
    throw new Error(`Fixture profile database is missing: ${profileDir}`);

  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = path.join(profileDir, `review-api.db${suffix}`);

    try {
      if ((await stat(sidecar)).size > 0)
        throw new Error(
          `Fixture profile still has a non-empty SQLite ${suffix} file after shutdown.`,
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
