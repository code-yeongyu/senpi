#!/usr/bin/env node
// `bun fmt --no-script` behind the Bun version gate in scripts/bun-builtin.mjs.

import { pathToFileURL } from "node:url";
import { runBuiltin, supportsBuiltin } from "./bun-builtin.mjs";

export const supportsFmt = supportsBuiltin;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = runBuiltin("fmt", process.argv.slice(2));
}
