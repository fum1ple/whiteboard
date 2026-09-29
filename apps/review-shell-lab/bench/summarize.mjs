const metricNames = [
  "startupMs",
  "idleCpuSeconds",
  "idleFootprintBytes",
  "operationCpuSeconds",
  "operationFootprintBytes",
  "residualProcessCount",
];

export function summarizeRuns(raw) {
  const hosts = {};
  const names = [...new Set(raw.runs.map((run) => run.host))].sort();

  for (const host of names) {
    const valid = raw.runs.filter((run) => run.host === host && run.valid);
    const requestedRuns = raw.requestedRunsPerHost;

    const completeMetrics = valid.every((run) =>
      metricNames.every((metric) => Number.isFinite(run[metric])),
    );

    if (valid.length !== requestedRuns || !completeMetrics) {
      hosts[host] = {
        validRuns: valid.length,
        requestedRuns,
        incomplete: true,
      };
      continue;
    }

    const summary = { validRuns: valid.length, requestedRuns };

    for (const metric of metricNames) {
      const values = valid.map((run) => run[metric]).sort((a, b) => a - b);
      summary[metric] = {
        median: median(values),
        min: values[0],
        max: values.at(-1),
      };
    }

    hosts[host] = summary;
  }

  return { schemaVersion: 1, hosts };
}

export function median(sortedValues) {
  if (!sortedValues.length) return null;
  const middle = Math.floor(sortedValues.length / 2);

  return sortedValues.length % 2 === 0
    ? (sortedValues[middle - 1] + sortedValues[middle]) / 2
    : sortedValues[middle];
}
