#!/usr/bin/env node
// Runs `bun fmt --no-script` with the caller's arguments (senpi#5572).
//
// `bun fmt` reads .oxfmtrc.json natively. A Bun older than 1.4.4 has no `fmt`
// command and resolves `bun fmt` to this package's `fmt` script instead, which
// would recurse forever, so such a Bun is refused before it runs.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
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

// Resolve the bun executable to an absolute path so it can be spawned
// without a shell (senpi#5599). Spawning bare `bun` through `shell: true` on
// win32 sends the whole command line through cmd.exe, which splits an
// argument containing spaces (`npm run fmt -- "path with spaces"`) into
// several. A resolved path needs no shell on any platform: Node quotes
// spaced arguments itself when it builds the child command line. On win32
// `.exe` wins over the PATHEXT shims so a `bun.cmd` wrapper can never
// shadow the real binary.
export function resolveBunExecutable(options = {}) {
	const platform = options.platform ?? process.platform;
	const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
	const exists = options.exists ?? existsSync;
	const joinPath = platform === "win32" ? win32.join : posix.join;
	const delimiter = platform === "win32" ? ";" : ":";
	const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ".com"] : [""];
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		for (const extension of extensions) {
			const candidate = joinPath(dir, `bun${extension}`);
			if (exists(candidate)) return candidate;
		}
	}
	return null;
}

function main() {
	const bun = resolveBunExecutable() ?? "bun";
	const probe = spawnSync(bun, ["--version"], { encoding: "utf8" });
	if (probe.error || probe.status !== 0) {
		console.error(`bun fmt: cannot run bun (${probe.error?.message ?? `exit ${probe.status}`}); install Bun >= ${MINIMUM.join(".")}`);
		return 1;
	}
	if (!supportsFmt(probe.stdout)) {
		console.error(`bun fmt needs Bun >= ${MINIMUM.join(".")}, found ${probe.stdout.trim()}`);
		return 1;
	}
	const result = spawnSync(bun, ["fmt", "--no-script", ...process.argv.slice(2)], {
		stdio: "inherit",
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
