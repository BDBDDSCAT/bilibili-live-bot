#!/usr/bin/env node
"use strict";

const path = require("node:path");
const OverlayExportService = require("../src/overlayExportService");

function parseArgs(argv = []) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, "..");
  const format = String(args.format || "bundle");
  const service = new OverlayExportService({
    rootDir,
    fps: args.fps,
    durationSec: args.duration,
  });
  const result = await service.generate({
    format,
    mode: args.mode || (format === "png" ? "static" : "scroll"),
    includeWebm: args.webm !== "false",
    baseUrl: args["base-url"] || "http://127.0.0.1:4322",
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
