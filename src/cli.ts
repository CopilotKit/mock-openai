#!/usr/bin/env node
import { parseArgs } from "node:util";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "./server.js";
import { loadFixtureFile, loadFixturesFromDir } from "./fixture-loader.js";

const HELP = `
Usage: llmock [options]

Options:
  -p, --port <number>      Port to listen on (default: 4010)
  -h, --host <string>      Host to bind to (default: 127.0.0.1)
  -f, --fixtures <path>    Path to fixtures directory or file (default: ./fixtures)
  -l, --latency <ms>       Latency in ms between SSE chunks (default: 0)
  -c, --chunk-size <chars>  Chunk size in characters (default: 20)
      --help               Show this help message
`.trim();

const { values } = parseArgs({
  options: {
    port: { type: "string", short: "p", default: "4010" },
    host: { type: "string", short: "h", default: "127.0.0.1" },
    fixtures: { type: "string", short: "f", default: "./fixtures" },
    latency: { type: "string", short: "l", default: "0" },
    "chunk-size": { type: "string", short: "c", default: "20" },
    help: { type: "boolean", default: false },
  },
  strict: true,
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const port = Number(values.port);
const host = values.host!;
const latency = Number(values.latency);
const chunkSize = Number(values["chunk-size"]);
const fixturePath = resolve(values.fixtures!);

if (Number.isNaN(port) || port < 0 || port > 65535) {
  console.error(`Invalid port: ${values.port}`);
  process.exit(1);
}

if (Number.isNaN(latency) || latency < 0) {
  console.error(`Invalid latency: ${values.latency}`);
  process.exit(1);
}

if (Number.isNaN(chunkSize) || chunkSize < 1) {
  console.error(`Invalid chunk-size: ${values["chunk-size"]}`);
  process.exit(1);
}

async function main() {
  // Load fixtures from path (detect file vs directory)
  let fixtures;
  try {
    const stat = statSync(fixturePath);
    if (stat.isDirectory()) {
      fixtures = loadFixturesFromDir(fixturePath);
    } else {
      fixtures = loadFixtureFile(fixturePath);
    }
  } catch {
    console.error(`Fixtures path not found: ${fixturePath}`);
    process.exit(1);
  }

  console.log(`Loaded ${fixtures.length} fixture(s) from ${fixturePath}`);

  const instance = await createServer(fixtures, {
    port,
    host,
    latency,
    chunkSize,
  });

  console.log(`llmock server listening on ${instance.url}`);

  function shutdown() {
    console.log("\nShutting down...");
    instance.server.close(() => {
      process.exit(0);
    });
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
