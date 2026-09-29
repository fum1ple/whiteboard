import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createReadyGate } from "../src/ready-gate.mjs";
import { createShellServer } from "../src/shell-server.mjs";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  return `http://127.0.0.1:${server.address().port}`;
}

test("same-origin API proxy adds the selected profile token and preserves response", async () => {
  let receivedToken;

  const api = createServer((request, response) => {
    receivedToken = request.headers["x-review-token"];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ reviewId: request.url.split("/").at(-1) }));
  });

  const apiUrl = await listen(api);

  const shell = await createShellServer({
    runId: "run-1",
    apiUrl,
    apiToken: "profile-token",
    readiness: createReadyGate({ runId: "run-1" }),
    cli: async () => "",
  });

  try {
    const response = await fetch(`${shell.origin}/reviews-api/review-123`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { reviewId: "review-123" });
    assert.equal(receivedToken, "profile-token");
  } finally {
    await shell.close();
    await new Promise((resolve) => api.close(resolve));
  }
});

test("readiness endpoint accepts only complete renders for its run", async () => {
  const readiness = createReadyGate({ runId: "run-2" });

  const shell = await createShellServer({
    runId: "run-2",
    apiUrl: "http://127.0.0.1:1",
    apiToken: "token",
    readiness,
    cli: async () => "",
  });

  try {
    const wrongRun = await fetch(`${shell.origin}/__ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-1",
        rendered: ["prose", "diagram", "diff", "code-reference"],
      }),
    });

    assert.equal(wrongRun.status, 409);
    assert.equal(readiness.ready, false);

    const complete = await fetch(`${shell.origin}/__ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-2",
        rendered: ["prose", "diagram", "diff", "code-reference"],
      }),
    });

    assert.equal(complete.status, 200);
    assert.equal((await complete.json()).ready, true);
  } finally {
    readiness.dispose();
    await shell.close();
  }
});

test("a missing code reference stays an API error and cannot satisfy run readiness", async () => {
  const api = createServer((_request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Referenced file was not found." }));
  });

  const apiUrl = await listen(api);
  const readiness = createReadyGate({ runId: "run-code-error" });
  const gateWait = readiness.wait().catch(() => undefined);

  const shell = await createShellServer({
    runId: "run-code-error",
    reviewId: "review-missing-file",
    apiUrl,
    apiToken: "profile-token",
    readiness,
    cli: async () => "",
  });

  try {
    const file = await fetch(
      `${shell.origin}/reviews-api/review-missing-file/file?side=head&file=missing.ts`,
    );

    assert.equal(file.status, 404);
    assert.deepEqual(await file.json(), {
      error: "Referenced file was not found.",
    });

    const incomplete = await fetch(`${shell.origin}/__ready`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        runId: "run-code-error",
        rendered: ["prose", "diagram", "diff"],
      }),
    });

    assert.equal(incomplete.status, 409);
    assert.equal(readiness.ready, false);
  } finally {
    readiness.dispose();
    await gateWait;
    await shell.close();
    await new Promise((resolve) => api.close(resolve));
  }
});

test("CLI launch accepts a review id and runs the fixed review query", async () => {
  let launchedReview;

  const shell = await createShellServer({
    runId: "run-3",
    reviewId: "review-456",
    apiUrl: "http://127.0.0.1:1",
    apiToken: "token",
    readiness: createReadyGate({ runId: "run-3" }),
    cli: async (reviewId) => {
      launchedReview = reviewId;

      return "Review query completed.";
    },
  });

  try {
    const response = await fetch(`${shell.origin}/__cli`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewId: "review-456" }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      output: "Review query completed.",
    });
    assert.equal(launchedReview, "review-456");
  } finally {
    await shell.close();
  }
});
