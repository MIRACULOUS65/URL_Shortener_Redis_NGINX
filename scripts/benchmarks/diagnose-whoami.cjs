const autocannon = require("autocannon");

const errorCounts = new Map();
const errorSamples = [];
const statusCodes = new Map();

const benchmark = autocannon({
  url: "http://localhost:8080/whoami",
  connections: 20,
  duration: 10,
  pipelining: 1
});

benchmark.on("response", (_client, statusCode) => {
  statusCodes.set(
    statusCode,
    (statusCodes.get(statusCode) ?? 0) + 1
  );
});

benchmark.on("reqError", (...args) => {
  const details = args
    .map((value) => {
      if (value instanceof Error) {
        return `${value.name}: ${value.message}${
          value.code ? ` [${value.code}]` : ""
        }`;
      }

      if (value === undefined) return "undefined";

      if (typeof value === "string") return value;

      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    })
    .join(" | ") || "No error details provided";

  errorCounts.set(
    details,
    (errorCounts.get(details) ?? 0) + 1
  );

  if (errorSamples.length < 10) {
    errorSamples.push(details);
  }
});

benchmark.on("error", (error) => {
  console.error("Autocannon setup error:", error);
});

benchmark.on("done", (results) => {
  console.log("\n=== Benchmark summary ===");

  console.log(JSON.stringify({
    url: results.url,
    connections: results.connections,
    duration: results.duration,
    errors: results.errors,
    timeouts: results.timeouts,
    non2xx: results.non2xx,
    statusCodeStats: results.statusCodeStats,
    observedStatusCodes: Object.fromEntries(statusCodes)
  }, null, 2));

  console.log("\n=== Request error details ===");

  console.log(
    errorCounts.size
      ? Object.fromEntries(errorCounts)
      : "No reqError events were emitted."
  );

  if (errorSamples.length > 0) {
    console.log("\nFirst error samples:");
    console.log(errorSamples);
  }
});