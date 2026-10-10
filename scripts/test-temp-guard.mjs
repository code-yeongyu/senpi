#!/usr/bin/env node
import { mkdirSync, opendirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function tempEntries(directory) {
	const handle = opendirSync(directory);
	const names = [];
	try {
		for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
			if (names.length === 100_000) throw new Error("temp guard exceeded 100000 top-level entries");
			names.push(entry.name);
		}
	} finally {
		handle.closeSync();
	}
	return names.sort();
}

export function reportTempLeaks(directory, before) {
	const known = new Set(before);
	const leaked = tempEntries(directory).filter((name) => !known.has(name));
	console.log(`[test-temp] new top-level entries after teardown: ${leaked.length}`);
	for (const name of leaked) console.error(`[test-temp] leftover: ${JSON.stringify(name)}`);
	return leaked.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [operation, file] = process.argv.slice(2);
	if (!file || !["snapshot", "check"].includes(operation)) {
		throw new Error("usage: test-temp-guard.mjs <snapshot|check> <snapshot.json>");
	}
	if (operation === "snapshot") {
		mkdirSync(dirname(file), { recursive: true });
		// Include the receipt itself in the baseline when a caller stores it in the temp root.
		writeFileSync(file, "");
		const directory = tmpdir();
		writeFileSync(file, JSON.stringify({ directory, entries: tempEntries(directory) }));
	} else {
		const snapshot = JSON.parse(readFileSync(file, "utf8"));
		process.exitCode = reportTempLeaks(snapshot.directory, snapshot.entries) === 0 ? 0 : 1;
	}
}
