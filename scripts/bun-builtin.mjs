#!/usr/bin/env node
// Runs a Bun 1.4.4 builtin (`bun fmt`, `bun check`) with `--no-script` (senpi#5572, senpi#4783).
//
// A Bun older than 1.4.4 lacks these commands and resolves `bun <name>` to this package's script of
// the same name, which would recurse forever, so such a Bun is refused before it runs.

import { spawnSync } from "node:child_process";

const MINIMUM = [1, 4, 4];

export function supportsBuiltin(version) {
	const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
	if (!parts) return false;
	for (let index = 0; index < MINIMUM.length; index++) {
		const part = Number(parts[index + 1]);
		if (part !== MINIMUM[index]) return part > MINIMUM[index];
	}
	return true;
}

export function runBuiltin(command, args) {
	const probe = spawnSync("bun", ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
	if (probe.error || probe.status !== 0) {
		console.error(`bun ${command}: cannot run bun (${probe.error?.message ?? `exit ${probe.status}`}); install Bun >= ${MINIMUM.join(".")}`);
		return 1;
	}
	if (!supportsBuiltin(probe.stdout)) {
		console.error(`bun ${command} needs Bun >= ${MINIMUM.join(".")}, found ${probe.stdout.trim()}`);
		return 1;
	}
	const result = spawnSync("bun", [command, "--no-script", ...args], {
		stdio: "inherit",
		shell: process.platform === "win32",
	});
	if (result.error) {
		console.error(`bun ${command}: ${result.error.message}`);
		return 1;
	}
	return result.status ?? 1;
}
