import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";

import { createReadyGate } from "../src/ready-gate.mjs";
import { createShellServer } from "../src/shell-server.mjs";

test("a missing code source remains visible and does not report shell readiness", async () => {
  const api = createServer((request, response) => {
    const url = new URL(request.url, "http://review.test");
    response.setHeader("content-type", "application/json");

    if (
      url.pathname === "/reviews-api/review-ui" &&
      url.searchParams.get("full") === "true"
    ) {
      response.end(
        JSON.stringify({
          reviewId: "review-ui",
          title: "Broken code reference",
          version: 1,
          document: [
            {
              type: "markdown",
              markdown:
                "Review this [missing symbol](review-source:head/src/missing.ts#L1).",
            },
            {
              type: "flow_diagram",
              title: "Flow",
              nodes: [{ key: "start", label: "Start", kind: "terminal" }],
              edges: [],
            },
          ],
        }),
      );

      return;
    }

    if (
      url.pathname === "/reviews-api/review-ui/diff" &&
      url.searchParams.get("format") === "files"
    ) {
      response.end(
        JSON.stringify([
          {
            path: "src/payment.ts",
            status: "modified",
            additions: 1,
            deletions: 0,
          },
        ]),
      );

      return;
    }

    if (url.pathname === "/reviews-api/review-ui/diff") {
      response.setHeader("content-type", "text/plain");
      response.end(
        "diff --git a/src/payment.ts b/src/payment.ts\n+return true;\n",
      );

      return;
    }

    if (url.pathname === "/reviews-api/review-ui/file") {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Source file was not found." }));

      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const readiness = createReadyGate({ runId: "run-ui", timeoutMs: 30_000 });
  const gateWait = readiness.wait().catch(() => undefined);

  const shell = await createShellServer({
    runId: "run-ui",
    reviewId: "review-ui",
    fixture: "small",
    apiUrl: `http://127.0.0.1:${api.address().port}`,
    apiToken: "test-token",
    readiness,
    cli: async () => "CLI remains available",
  });

  const browserErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => browserErrors.push(error.message));
  let dom;

  try {
    dom = await JSDOM.fromURL(shell.url, {
      resources: "usable",
      runScripts: "dangerously",
      pretendToBeVisual: true,
      virtualConsole,
      beforeParse(window) {
        window.fetch = (input, options) =>
          fetch(new URL(input, window.location.href), options);
      },
    });
    await new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        const status =
          dom.window.document.querySelector("#status")?.textContent;

        if (status?.includes("incomplete")) {
          clearInterval(interval);
          resolve();
        } else if (status === "Review failed") {
          clearInterval(interval);
          reject(
            new Error(dom.window.document.querySelector("#app")?.textContent),
          );
        }
      }, 10);

      setTimeout(() => {
        clearInterval(interval);
        reject(new Error("Review UI did not finish rendering."));
      }, 5_000).unref?.();
    });

    assert.match(
      dom.window.document.querySelector("#app").textContent,
      /Could not load src\/missing\.ts: Source file was not found\./,
    );
    assert.equal(dom.window.document.querySelector("#cli-run").disabled, false);
    assert.equal(readiness.ready, false);
    assert.deepEqual(browserErrors, []);
  } finally {
    dom?.window.close();
    readiness.dispose();
    await gateWait;
    await shell.close();
    await new Promise((resolve) => api.close(resolve));
  }
});
