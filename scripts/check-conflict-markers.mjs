#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// `=======` alone is also a Markdown setext heading underline, so only the unambiguous
// open, diff3-base and close markers are rejected.
const markerLine = /^(?:<<<<<<<|\|\|\|\|\|\|\||>>>>>>>)(?: |$)/;

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
	.split("\0")
	.filter(Boolean);

const failures = [];
for (const file of tracked) {
	let bytes;
	try {
		bytes = readFileSync(file);
	} catch {
		continue; // deleted in the working tree but still in the index
	}
	if (bytes.subarray(0, 8000).includes(0)) continue; // binary
	const lines = bytes.toString("utf8").split("\n");
	for (let index = 0; index < lines.length; index++) {
		if (markerLine.test(lines[index])) failures.push(`${file}:${index + 1}: ${lines[index].slice(0, 80)}`);
	}
}

if (failures.length > 0) {
	console.error("Committed merge-conflict marker lines (resolve the conflict and delete them):");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log(`conflict markers: none in ${tracked.length} tracked files`);
