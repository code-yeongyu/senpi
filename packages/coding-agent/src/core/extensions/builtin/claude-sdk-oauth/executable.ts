import { createRequire } from "node:module";
import { extractFromBunfs } from "@anthropic-ai/claude-agent-sdk/extract";

export type ExecutableDeps = {
	platform: string;
	arch: string;
	env: (name: string) => string | undefined;
	resolve: (spec: string) => string;
	isMusl?: () => boolean;
	isCompiledBun?: () => boolean;
	extractFromBunfs?: (embeddedPath: string) => string;
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

function firstResolvable(candidates: string[], resolve: (spec: string) => string): string | undefined {
	for (const candidate of candidates) {
		try {
			return resolve(candidate);
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

export function resolveClaudeCodeExecutable(deps: ExecutableDeps): string {
	const override = deps.env("CLAUDE_CODE_EXECUTABLE");
	if (override) return override;

	const candidates = claudeCodeExecutableCandidates(
		deps.platform,
		deps.arch,
		deps.platform === "linux" && deps.isMusl?.() === true,
	);

	if (deps.isCompiledBun?.() && deps.extractFromBunfs) {
		const embedded = firstResolvable(candidates, deps.resolve);
		if (embedded !== undefined) {
			try {
				return deps.extractFromBunfs(embedded);
			} catch {
				// not embedded in the bundle - fall through to the on-disk probe
			}
		}
	}

	const resolved = firstResolvable(candidates, deps.resolve);
	if (resolved !== undefined) return resolved;

	throw new Error(
		`Claude native binary not found for ${deps.platform}-${deps.arch}. ` +
			"Reinstall @anthropic-ai/claude-agent-sdk without --omit=optional, or set CLAUDE_CODE_EXECUTABLE.",
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

export function defaultExecutableDeps(): ExecutableDeps {
	return {
		platform: process.platform,
		arch: process.arch,
		env: (name) => process.env[name],
		isMusl: isMuslLinuxRuntime,
		isCompiledBun: () => isCompiledBunBinary,
		extractFromBunfs,
		resolve: (spec) => {
			if (!defaultRequire) {
				defaultRequire = createRequire(import.meta.resolve("@anthropic-ai/claude-agent-sdk"));
			}
			return defaultRequire.resolve(spec);
		},
	};
}
