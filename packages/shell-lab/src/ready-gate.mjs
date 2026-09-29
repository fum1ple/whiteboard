const required = ["prose", "diagram", "diff", "code-reference"];

export function createReadyGate({ runId, timeoutMs = 120_000 }) {
  const rendered = new Set();
  let settled = false;
  let resolveReady;
  let rejectReady;
  const promise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = setTimeout(() => {
    const missing = required.filter((part) => !rendered.has(part));
    settled = true;
    rejectReady(new Error(`Render readiness timed out; missing ${missing.join(", ")}.`));
  }, timeoutMs);
  timer.unref?.();

  return {
    get ready() {
      return required.every((part) => rendered.has(part));
    },
    markRendered(part) {
      if (settled || !required.includes(part)) return;
      rendered.add(part);

      if (required.every((item) => rendered.has(item))) {
        settled = true;
        clearTimeout(timer);
        resolveReady({ runId, rendered: required.filter((item) => rendered.has(item)) });
      }
    },
    wait() {
      return promise;
    },
    dispose() {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        rejectReady(new Error("Render readiness was cancelled."));
      }
    },
  };
}
