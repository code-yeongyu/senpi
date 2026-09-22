import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { posix, win32 } from "node:path";
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";
import { findExecutableOnPath } from "./executable-path-lookup.ts";

export type ExecutableDeps = {
	platform: string;
	arch: string;
	env: (name: string) => string | undefined;
	resolve: (spec: string) => string;
	/** True when `path` names an existing regular file in THIS process - what the SDK's spawn will see. */
	isFile: (path: string) => boolean;
	isMusl?: () => boolean;
	isCompiledBun?: () => boolean;
	extractFromBunfs?: (embeddedPath: string) => string;
};

export type ExecutableResolution = {
	/** The spawnable spelling, or `undefined` when every candidate was rejected. */
	executable: string | undefined;
	/** Every spelling checked, in order; the last entry is the winner when `executable` is set. */
	tried: string[];
};

export function claudeCodeExecutableCandidates(platform: string, arch: string, preferMusl = false): string[] {
	const ext = platform === "win32" ? ".exe" : "";
	if (platform === "linux") {
		const glibc = `@anthropic-ai/claude-agent-sdk-linux-${arch}/claude${ext}`;
		const musl = `@anthropic-ai/claude-agent-sdk-linux-${arch}-musl/claude${ext}`;
		return preferMusl ? [musl, glibc] : [glibc, musl];
	}
	return [`@anthropic-ai/claude-agent-sdk-${platform}-${arch}/claude${ext}`];
}

/**
 * The spelling handed to the SDK, which spawns it verbatim: absolute, and on win32 in the `\\?\`
 * namespaced form so a path Explorer can see but `uv_fs_stat`/`CreateProcess` reject (MAX_PATH, the
 * npm-global layout in #1541) still launches. The same spelling is what {@link ExecutableDeps.isFile}
 * validates, so the check and the spawn see one string.
 */
function spawnableSpelling(platform: string, candidate: string): string {
	return platform === "win32" ? win32.toNamespacedPath(win32.resolve(candidate)) : posix.resolve(candidate);
}

/**
 * Walks every source of a Claude Code binary and records each spelling it checked. Nothing is
 * accepted on resolution alone: `require.resolve` can name a file this process cannot stat (#1541),
 * so a candidate counts only once `isFile` agrees. Order: `CLAUDE_CODE_EXECUTABLE`, the embedded
 * binary of a compiled Bun build, the platform sidecar package(s), then `claude` on PATH.
 */
export function describeClaudeCodeExecutable(deps: ExecutableDeps): ExecutableResolution {
	const tried: string[] = [];
	const accept = (candidate: string): string | undefined => {
		const spelled = spawnableSpelling(deps.platform, candidate);
		tried.push(spelled);
		return deps.isFile(spelled) ? spelled : undefined;
	};
	const done = (executable: string): ExecutableResolution => ({ executable, tried });

	const override = deps.env("CLAUDE_CODE_EXECUTABLE");
	if (override) {
		const accepted = accept(override);
		if (accepted !== undefined) return done(accepted);
	}

	const candidates = claudeCodeExecutableCandidates(
		deps.platform,
		deps.arch,
		deps.platform === "linux" && deps.isMusl?.() === true,
	);

	if (deps.isCompiledBun?.() && deps.extractFromBunfs) {
		for (const candidate of candidates) {
			let extracted: string;
			try {
				extracted = deps.extractFromBunfs(deps.resolve(candidate));
			} catch {
				continue; // not embedded in this bundle - the on-disk probe below still runs
			}
			const accepted = accept(extracted);
			if (accepted !== undefined) return done(accepted);
		}
	}

	for (const candidate of candidates) {
		let resolved: string;
		try {
			resolved = deps.resolve(candidate);
		} catch {
			tried.push(candidate); // the package is not installed; name it by specifier
			continue;
		}
		const accepted = accept(resolved);
		if (accepted !== undefined) return done(accepted);
	}

	const onPath = findExecutableOnPath("claude", deps);
	if (onPath !== undefined) {
		const accepted = accept(onPath);
		if (accepted !== undefined) return done(accepted);
	} else {
		tried.push(deps.env("PATH") ? "claude on PATH" : "claude on PATH (PATH is unset)");
	}

	return { executable: undefined, tried };
}

/** The validated executable, or senpi's own error naming every candidate - the SDK never sees a miss. */
export function resolveClaudeCodeExecutable(deps: ExecutableDeps): string {
	const resolution = describeClaudeCodeExecutable(deps);
	if (resolution.executable !== undefined) return resolution.executable;
	throw new Error(
		[
			`Claude Code executable not found for ${deps.platform}-${deps.arch}. Tried:`,
			...resolution.tried.map((candidate) => `  - ${candidate}`),
			"Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, install Claude Code so `claude` is on PATH, " +
				"or set CLAUDE_CODE_EXECUTABLE to the binary.",
		].join("\n"),
	);
}

let defaultRequire: ReturnType<typeof createRequire> | null = null;

const isCompiledBunBinary =
	import.meta.url.includes("$bunfs") || import.meta.url.includes("~BUN") || import.meta.url.includes("%7EBUN");

function isMuslLinuxRuntime(): boolean {
	if (process.platform !== "linux" || typeof process.report?.getReport !== "function") return false;
	const report = process.report.getReport();
	if (report === null || !("header" in report) || typeof report.header !== "object" || report.header === null) {
		return false;
	}
	return !("glibcVersionRuntime" in report.header) || report.header.glibcVersionRuntime === undefined;
}

function isRegularFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false; // ENOENT, EACCES, ENAMETOOLONG, ...: the spawn would fail the same way
	}
}

const defaultDeps: ExecutableDeps = {
	platform: process.platform,
	arch: process.arch,
	env: (name) => process.env[name],
	isFile: isRegularFile,
	isMusl: isMuslLinuxRuntime,
	isCompiledBun: () => isCompiledBunBinary,
	extractFromBunfs,
	// Rooted at the SDK instance this extension imports, so `require.resolve` walks the parents of
	// THAT package and a sidecar hoisted above it (omo-ai/node_modules/...) is still found.
	resolve: (spec) => {
		if (!defaultRequire) {
			defaultRequire = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
		}
		return defaultRequire.resolve(spec);
	},
};
let activeDeps = defaultDeps;

export function defaultExecutableDeps(): ExecutableDeps {
	return activeDeps;
}

export function overrideExecutableDeps(override: Partial<ExecutableDeps>): void {
	activeDeps = { ...activeDeps, ...override };
}

export function resetExecutableDeps(): void {
	activeDeps = defaultDeps;
}
