#!/usr/bin/env node
// Runs `bun fmt --no-script` with the caller's arguments (senpi#5572).
//
// `bun fmt` reads .oxfmtrc.json natively. A Bun older than 1.4.4 has no `fmt`
// command and resolves `bun fmt` to this package's `fmt` script instead, which
// would recurse forever, so such a Bun is refused before it runs.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MINIMUM = [1, 4, 4];

export function supportsFmt(version) {
	const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!parts) return false;
	for (let index = 0; index < MINIMUM.length; index++) {
		const part = Number(parts[index + 1]);
		if (part !== MINIMUM[index]) return part > MINIMUM[index];
	}
	return true;
}

function main() {
	const probe = spawnSync("bun", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
	if (probe.error || probe.status !== 0) {
		console.error(`bun fmt: cannot run bun (${probe.error?.message ?? `exit ${probe.status}`}); install Bun >= ${MINIMUM.join(".")}`);
		return 1;
	}
	if (!supportsFmt(probe.stdout)) {
		console.error(`bun fmt needs Bun >= ${MINIMUM.join(".")}, found ${probe.stdout.trim()}`);
		return 1;
	}
	const result = spawnSync("bun", ["fmt", "--no-script", ...process.argv.slice(2)], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.error) {
		console.error(`bun fmt: ${result.error.message}`);
		return 1;
	}
	return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	process.exitCode = main();
}
