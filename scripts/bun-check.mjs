#!/usr/bin/env node
// `bun check --no-script` behind the Bun version gate in scripts/bun-builtin.mjs.

import { pathToFileURL } from "node:url";
import { runBuiltin, supportsBuiltin } from "./bun-builtin.mjs";

export const supportsCheck = supportsBuiltin;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = runBuiltin("check", process.argv.slice(2));
}
