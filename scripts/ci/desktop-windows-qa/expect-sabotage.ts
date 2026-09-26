#!/usr/bin/env node
// Asserts a sabotaged QA run failed the way it must: the JSONL line of `<scenario>` has
// `pass:false` and `reason` equal to `<reason>`.
//   bun scripts/ci/desktop-windows-qa/expect-sabotage.ts <run.jsonl> <scenario> <reason>
import { readFileSync } from "node:fs";

const [file, scenario, reason] = process.argv.slice(2);
if (file === undefined || scenario === undefined || reason === undefined) {
	console.error("usage: expect-sabotage.ts <run.jsonl> <scenario> <reason>");
	process.exit(2);
}

const lines = readFileSync(file, "utf8")
	.split("\n")
	.filter((line) => line.trim() !== "")
	.map((line): unknown => JSON.parse(line));
const line = lines.find(
	(entry): entry is Record<string, unknown> =>
		typeof entry === "object" && entry !== null && "scenario" in entry && entry.scenario === scenario,
);
if (line === undefined) {
	console.error(`sabotage: no '${scenario}' line in ${file}`);
	process.exit(1);
}
console.log(`sabotage: ${JSON.stringify({ scenario, pass: line.pass, reason: line.reason })}`);
if (line.pass !== false || line.reason !== reason) {
	console.error(`sabotage: expected ${scenario} pass:false reason ${reason}`);
	process.exit(1);
}
console.log(`sabotage: ok (${scenario} reported pass:false reason ${reason})`);
