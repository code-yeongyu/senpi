#!/usr/bin/env node
// The README must name every eval surface a cell can use: each language's helpers from the gate's golden census, the
// line magics, and the handle methods. Exits 1 listing what is missing.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const golden = JSON.parse(readFileSync(join(root, "test", "gate", "helpers.golden.json"), "utf8"));

const MAGICS = ["%pip install", "%environment", "%load", "%bun add", "%npm add"];
const HANDLE_METHODS = ["wait(", "handle(", ".status(", ".output(", ".cancel(", ".send("];

const named = (name) => readme.includes(`\`${name}`) || readme.includes(`${name}(`);
const missing = [];
for (const [language, names] of Object.entries(golden)) {
	if (!Array.isArray(names)) continue;
	for (const name of names) if (!named(name)) missing.push(`${language} helper ${name}`);
}
for (const magic of MAGICS) if (!readme.includes(magic)) missing.push(`magic ${magic}`);
for (const method of HANDLE_METHODS) if (!readme.includes(method)) missing.push(`handle ${method}`);

if (missing.length > 0) {
	process.stderr.write(`README.md does not document:\n${missing.map((item) => `  - ${item}`).join("\n")}\n`);
	process.exit(1);
}
process.stdout.write(`README.md documents all ${Object.values(golden).flat().length} helpers, ${MAGICS.length} magics and ${HANDLE_METHODS.length} handle methods\n`);
