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
 *
 * Under an adopted engine trust generation (omo#10762) each generation gets its own directory, and
 * its shims set that generation for their own exec only (`bundled-bun-shim.ts`).
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { getAgentDir } from "../config.ts";
import { adoptedEngineTrust } from "../engine-trust/adopted.ts";
import type { EngineTrustMarker } from "../engine-trust/marker.ts";
import { cmdShimFiles, posixShimFiles, type ShimFiles } from "./bundled-bun-shim.ts";

/** Facts about the running process; injectable so the decision is testable on any runtime. */
export interface BundledBunHost {
	readonly main: string | undefined;
	readonly execPath: string;
	readonly platform: NodeJS.Platform;
	readonly shimRoots: readonly string[];
	/** The generation this process adopted; absent for a process that runs without one. */
	readonly trust?: EngineTrustMarker | undefined;
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
		trust: adoptedEngineTrust(),
	};
}

function shimFiles(host: BundledBunHost, dir: string): ShimFiles {
	return host.platform === "win32"
		? cmdShimFiles(host.execPath, dir, host.trust)
		: posixShimFiles(host.execPath, dir, host.trust);
}

/**
 * Today's key without a generation. With one, the key adds every input the shim's bytes depend on,
 * so two generations, or one generation under two launch kinds, never share a directory.
 */
function shimKey(host: BundledBunHost): string {
	const { trust } = host;
	if (trust === undefined) return host.execPath;
	const closure = trust.defaults === null ? "opt-in" : `${trust.defaults.file}\0${trust.defaults.dir}`;
	return [host.execPath, trust.file, closure, trust.owner, trust.fallbackReason ?? "complete"].join("\0");
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
	const dir = join(root, createHash("sha256").update(shimKey(host)).digest("hex").slice(0, 16));
	try {
		mkdirSync(dir, { recursive: true });
		for (const [name, content] of shimFiles(host, dir)) writeIfChanged(join(dir, name), content);
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
	const key = `${shimKey(host)}\0${host.shimRoots.join("\0")}`;
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
