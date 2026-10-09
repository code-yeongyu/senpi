/**
 * `bun` for agent shells inside a `bun build --compile` executable.
 *
 * Bun Shell resolves a `bun` command to `process.execPath` when no `bun` is on PATH. In a compiled
 * executable that is the app itself, and without `BUN_BE_BUN=1` the app runs its own entrypoint: an
 * agent's `bun test` boots a second agent and its reply comes back as exit-0 output (omo#9362). The
 * child cannot tell it was meant to be Bun (argv and argv0 match a normal launch), so the fix lives
 * on the parent side: agent shells get a directory APPENDED to PATH whose `bun`/`bunx` run this
 * executable with `BUN_BE_BUN=1`. Appending keeps a user's own Bun on PATH in front, and the variable
 * is set only for that one command, so the engine's own self-spawns keep running the engine.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getAgentDir } from "../config.ts";

/** Facts about the running process; injectable so the decision is testable on any runtime. */
export interface BundledBunHost {
	readonly main: string | undefined;
	readonly execPath: string;
	readonly platform: NodeJS.Platform;
	readonly shimRoots: readonly string[];
}

/** Bun's embedded filesystem root: `/$bunfs/` on POSIX, `<drive>:\~BUN\` on Windows. */
const EMBEDDED_ENTRY = /^(?:\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/;

export function isCompiledBunExecutable(main: string | undefined): boolean {
	return main !== undefined && EMBEDDED_ENTRY.test(main);
}

function currentHost(): BundledBunHost {
	const bun = (globalThis as { Bun?: { main?: string } }).Bun;
	return {
		main: bun?.main,
		execPath: process.execPath,
		platform: process.platform,
		shimRoots: [join(getAgentDir(), "bundled-bun"), join(tmpdir(), "senpi-bundled-bun")],
	};
}

function shimFiles(execPath: string, platform: NodeJS.Platform): ReadonlyArray<readonly [string, string]> {
	if (platform === "win32") {
		const run = (extra: string) =>
			`@echo off\r\nset BUN_BE_BUN=1\r\n"${execPath}" ${extra}%*\r\nexit /b %ERRORLEVEL%\r\n`;
		return [
			["bun.cmd", run("")],
			["bunx.cmd", run("x ")],
		];
	}
	const quoted = `'${execPath.replaceAll("'", `'\\''`)}'`;
	return [
		["bun", `#!/bin/sh\nBUN_BE_BUN=1 exec ${quoted} "$@"\n`],
		["bunx", `#!/bin/sh\nBUN_BE_BUN=1 exec ${quoted} x "$@"\n`],
	];
}

function writeIfChanged(path: string, content: string): void {
	let current: string | undefined;
	try {
		current = readFileSync(path, "utf8");
	} catch {}
	if (current !== content) {
		const staged = `${path}.${process.pid}.tmp`;
		writeFileSync(staged, content, { mode: 0o755 });
		renameSync(staged, path);
	}
	chmodSync(path, 0o755);
}

function materialize(root: string, host: BundledBunHost): string | undefined {
	const dir = join(root, createHash("sha256").update(host.execPath).digest("hex").slice(0, 16));
	try {
		mkdirSync(dir, { recursive: true });
		for (const [name, content] of shimFiles(host.execPath, host.platform)) writeIfChanged(join(dir, name), content);
		return dir;
	} catch {
		return undefined;
	}
}

const resolved = new Map<string, string | undefined>();

/**
 * The directory holding this executable's `bun`/`bunx` commands, created on first use; `undefined`
 * outside a compiled executable, or when no candidate root is writable.
 */
export function bundledBunDir(host: BundledBunHost = currentHost()): string | undefined {
	if (!isCompiledBunExecutable(host.main)) return undefined;
	const key = `${host.execPath}\0${host.shimRoots.join("\0")}`;
	if (!resolved.has(key)) {
		let dir: string | undefined;
		for (const root of host.shimRoots) {
			dir = materialize(root, host);
			if (dir !== undefined) break;
		}
		resolved.set(key, dir);
	}
	return resolved.get(key);
}

/** `env` with the bundled `bun` directory appended to its PATH when this process is a compiled executable. */
export function withBundledBunCommands(env: NodeJS.ProcessEnv, host?: BundledBunHost): NodeJS.ProcessEnv {
	const dir = bundledBunDir(host);
	if (dir === undefined) return env;
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
	if (entries.includes(dir)) return env;
	return { ...env, [pathKey]: [...entries, dir].join(delimiter) };
}
