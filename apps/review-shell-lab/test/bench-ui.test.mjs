import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { JSDOM, VirtualConsole } from "jsdom";

import { createReadyGate } from "../src/ready-gate.mjs";
import { createShellServer } from "../src/shell-server.mjs";

test("benchmark mode exercises the rendered review and reports every stage", async () => {
  let scenario;

  const api = createServer(async (request, response) => {
    const url = new URL(request.url, "http://review.test");
    response.setHeader("content-type", "application/json");

    if (
      url.pathname === "/reviews-api/review-bench" &&
      url.searchParams.get("full") === "true"
    ) {
      response.end(
        JSON.stringify({
          reviewId: "review-bench",
          title: "Fixture review",
          version: 1,
          document: [
            {
              type: "markdown",
              markdown:
                "## Payment validation\n\nUse the [validation branch](review-source:head/src/payment.ts#L1).",
            },
            {
              type: "flow_diagram",
              title: "Payment flow",
              nodes: [
                {
                  key: "validate",
                  label: "Validate",
                  kind: "process",
                  attachments: [
                    {
                      label: "Validation",
                      sources: [
                        {
                          file: "src/payment.ts",
                          start: { side: "head", line: 1 },
                          end: { side: "head", line: 1 },
                        },
                      ],
                    },
                  ],
                },
              ],
              edges: [],
            },
            {
              type: "sequence",
              title: "Request lifecycle",
              actors: { checkout: "Checkout", payments: "Payments" },
              steps: [
                {
                  from: "checkout",
                  to: "payments",
                  label: "submit",
                  style: "call",
                },
              ],
            },
          ],
        }),
      );

      return;
    }

    if (
      url.pathname.endsWith("/diff") &&
      url.searchParams.get("format") === "files"
    ) {
      response.end(
        JSON.stringify(
          ["src/payment.ts", "src/extra.ts"].map((file) => ({
            path: file,
            status: "modified",
            additions: 1,
            deletions: 0,
          })),
        ),
      );

      return;
    }

    if (url.pathname.endsWith("/diff")) {
      response.setHeader("content-type", "text/plain");
      response.end(
        `diff --git a/${url.searchParams.get("paths")} b/${url.searchParams.get("paths")}\n+return true;`,
      );

      return;
    }

    if (url.pathname.endsWith("/file")) {
      response.end(JSON.stringify({ text: "return true;" }));

      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const readiness = createReadyGate({ runId: "run-bench", timeoutMs: 30_000 });
  const gateWait = readiness.wait().catch(() => undefined);

  const shell = await createShellServer({
    runId: "run-bench",
    reviewId: "review-bench",
    fixture: "medium",
    apiUrl: `http://127.0.0.1:${api.address().port}`,
    apiToken: "test-token",
    readiness,
    bench: true,
    cli: async () => "CLI review data",
  });

  const errors = [];
  const scrollCalls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error) => errors.push(error.message));
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
        window.Element.prototype.scrollIntoView = function scrollIntoView(
          options,
        ) {
          scrollCalls.push({ tagName: this.tagName, options });
        };

        window.HTMLDialogElement.prototype.showModal = function showModal() {
          this.open = true;
        };
      },
    });
    await poll(() => readiness.ready);
    await fetch(`${shell.origin}/__bench`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "start" }),
    });
    await poll(async () => {
      scenario = await fetch(`${shell.origin}/__bench`).then((response) =>
        response.json(),
      );

      return ["complete", "failed"].includes(scenario.state);
    });
    assert.equal(scenario.state, "complete");
    assert.equal(scrollCalls.length, 2);
    assert.ok(scrollCalls.every((call) => call.tagName === "FIGURE"));
    assert.deepEqual(
      scenario.stages.map((stage) => stage.name),
      [
        "scroll-review-and-diagrams",
        "open-prose-code-reference",
        "open-diagram-code-reference",
        "select-changed-file",
        "run-review-cli",
      ],
    );
    assert.equal(readiness.ready, true);
    assert.deepEqual(errors, []);
  } finally {
    dom?.window.close();
    readiness.dispose();
    await gateWait;
    await shell.close();
    await new Promise((resolve) => api.close(resolve));
  }
});

async function poll(predicate) {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error("Benchmark UI scenario did not finish.");
}
