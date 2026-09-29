import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const requiredRenders = ["prose", "diagram", "diff", "code-reference"];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function createShellServer({
  runId,
  reviewId,
  fixture,
  apiUrl,
  apiToken,
  apiPid,
  instanceId,
  readiness,
  cli,
  bench = false,
}) {
  let benchResult;

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");

      if (url.pathname.startsWith("/reviews-api/")) {
        await proxyApi(request, response, url, apiUrl, apiToken);

        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        await sendFile(
          response,
          path.join(root, "public", "index.html"),
          "text/html; charset=utf-8",
        );

        return;
      }

      if (request.method === "GET" && url.pathname === "/assets/main.js") {
        await sendFile(
          response,
          path.join(root, "public", "main.js"),
          "text/javascript; charset=utf-8",
        );

        return;
      }

      if (request.method === "GET" && url.pathname === "/assets/style.css") {
        await sendFile(
          response,
          path.join(root, "public", "style.css"),
          "text/css; charset=utf-8",
        );

        return;
      }

      if (request.method === "GET" && url.pathname === "/__state") {
        sendJson(response, 200, {
          runId,
          reviewId,
          fixture,
          apiPid,
          instanceId,
          bench,
        });

        return;
      }

      if (request.method === "POST" && url.pathname === "/__ready") {
        const body = await readJson(request);

        const complete =
          body.runId === runId &&
          Array.isArray(body.rendered) &&
          requiredRenders.every((part) => body.rendered.includes(part));

        if (!complete) {
          sendJson(response, 409, { ready: false, required: requiredRenders });

          return;
        }

        for (const part of requiredRenders) readiness.markRendered(part);
        sendJson(response, 200, { ready: readiness.ready, runId });

        return;
      }

      if (request.method === "POST" && url.pathname === "/__cli") {
        const body = await readJson(request);

        if (body.reviewId !== reviewId) {
          sendJson(response, 400, {
            error: "The selected review does not match this run.",
          });

          return;
        }

        sendJson(response, 200, { output: await cli(reviewId) });

        return;
      }

      if (url.pathname === "/__bench" && bench) {
        if (request.method === "GET") {
          sendJson(response, 200, benchResult ?? { state: "waiting" });

          return;
        }

        if (request.method === "POST") {
          const result = await readJson(request);

          if (result.command === "start") benchResult = { state: "start" };
          else if (["complete", "failed"].includes(result.state))
            benchResult = result;
          else {
            sendJson(response, 400, { error: "Unknown benchmark command." });

            return;
          }

          sendJson(response, 200, { accepted: true });

          return;
        }
      }

      sendJson(response, 404, { error: "Not found" });
    } catch (error) {
      if (!response.headersSent)
        sendJson(response, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    url: `http://127.0.0.1:${server.address().port}/?review=${encodeURIComponent(reviewId)}&run=${encodeURIComponent(runId)}`,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function proxyApi(request, response, url, apiUrl, apiToken) {
  const target = new URL(url.pathname + url.search, apiUrl);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.set("x-review-token", apiToken);

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request,
    duplex:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : "half",
  });

  response.writeHead(upstream.status, Object.fromEntries(upstream.headers));

  if (upstream.body) Readable.fromWeb(upstream.body).pipe(response);
  else response.end();
}

async function sendFile(response, file, type) {
  response.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
  });
  response.end(await readFile(file));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > 1024 * 1024) throw new Error("Request body exceeds 1 MiB.");
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}
