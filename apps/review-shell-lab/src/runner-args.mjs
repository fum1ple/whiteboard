const hosts = new Set(["electron", "tauri", "wails"]);

const fixtures = new Set(["small", "medium", "large"]);

export function parseRunArgs(args) {
  if (args[0] !== "run") throw new Error("Expected: shell-lab run <options>");

  const values = new Map();

  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];

    if (
      !option?.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error(
        `Expected a value after ${option ?? "the final option"}.`,
      );

    if (values.has(option))
      throw new Error(`${option} may only be specified once.`);
    values.set(option, value);
  }

  const allowed = new Set(["--host", "--fixture", "--review", "--profile"]);

  for (const option of values.keys())
    if (!allowed.has(option)) throw new Error(`Unknown option: ${option}`);

  const host = values.get("--host");
  const fixture = values.get("--fixture");
  const reviewId = values.get("--review");
  const profileDir = values.get("--profile");

  if (!hosts.has(host))
    throw new Error("--host must be electron, tauri, or wails.");

  if (!fixtures.has(fixture))
    throw new Error("--fixture must be small, medium, or large.");

  if (!reviewId?.trim())
    throw new Error("--review must name an existing review.");

  if (!profileDir?.trim())
    throw new Error("--profile must name an isolated profile directory.");

  return { host, fixture, reviewId, profileDir };
}
