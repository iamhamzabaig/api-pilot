#!/usr/bin/env node
import { parseArgs } from "node:util";
import { version } from "../version.js";

const HELP = `api-pilot ${version}

AI-native API execution engine. Nothing is implemented yet — this is the M0 scaffold.

Usage:
  api-pilot --version
  api-pilot --help
`;

const { values } = parseArgs({
  options: {
    version: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
  allowPositionals: true,
  strict: false,
});

process.stdout.write(values.version ? `${version}\n` : HELP);
