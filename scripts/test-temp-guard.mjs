#!/usr/bin/env node
import { appendFileSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
	// Inspect only a bounded set of run-owner directories; never recurse or remove them.
	for (const name of leaked.filter((entry) => entry.startsWith("st-")).slice(0, 4)) {
		const path = join(directory, name);
		if (!lstatSync(path).isDirectory()) continue;
		const handle = opendirSync(path);
		const contents = [];
		try {
			for (let entry = handle.readSync(); entry && contents.length < 8; entry = handle.readSync()) {
				contents.push(entry.name);
			}
		} finally {
			handle.closeSync();
		}
		console.error(`[test-temp] leftover owner contents ${JSON.stringify(name)}: ${JSON.stringify(contents.sort())}`);
	}
	return leaked.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [operation, file, option] = process.argv.slice(2);
	if (!file || !["snapshot", "check"].includes(operation) || (option && option !== "--export-env")) {
		throw new Error("usage: test-temp-guard.mjs <snapshot|check> <snapshot.json>");
	}
	if (operation === "snapshot") {
		mkdirSync(dirname(file), { recursive: true });
		const registry = resolve(`${file}.owners.jsonl`);
		writeFileSync(registry, "");
		// Include the receipt itself in the baseline when a caller stores it in the temp root.
		writeFileSync(file, "");
		const directory = tmpdir();
		writeFileSync(file, JSON.stringify({ directory, entries: tempEntries(directory), registry }));
		if (option === "--export-env") {
			if (!process.env.GITHUB_ENV) throw new Error("--export-env requires GITHUB_ENV");
			appendFileSync(process.env.GITHUB_ENV, `SENPI_TEST_TEMP_REGISTRY=${registry}\n`);
		}
	} else {
		const snapshot = JSON.parse(readFileSync(file, "utf8"));
		if (statSync(snapshot.registry).size > 8 * 1024 * 1024) throw new Error("temp ownership journal exceeds 8 MiB");
		const baseline = new Set(snapshot.entries);
		const roots = new Set(readFileSync(snapshot.registry, "utf8").split("\n").filter(Boolean).map((line) => {
			const root = JSON.parse(line);
			if (
				typeof root !== "string" || !isAbsolute(root) || !basename(root).startsWith("st-") ||
				(resolve(dirname(root)) === resolve(snapshot.directory) && baseline.has(basename(root)))
			) throw new Error("invalid temp ownership record");
			return root;
		}));
		let retired = 0;
		for (const root of roots) {
			if (existsSync(root)) {
				console.log(`[test-temp] retiring recorded owned root: ${JSON.stringify(root)}`);
				rmSync(root, { recursive: true, force: true, maxRetries: 3 });
				retired++;
			}
		}
		console.log(`[test-temp] recorded owned roots retired at job teardown: ${retired}`);
		process.exitCode = reportTempLeaks(snapshot.directory, snapshot.entries) === 0 ? 0 : 1;
	}
}
