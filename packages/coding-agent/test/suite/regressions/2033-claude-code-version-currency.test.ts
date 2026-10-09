import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	type ExecutableDeps,
	resolveClaudeCodeExecutable,
} from "../../../src/core/extensions/builtin/anthropic-subscription/executable.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const SIDECAR = "/sdk/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude";
const ON_PATH = "/usr/local/bin/claude";

function installedSdkClaudeCodeVersion(): string {
	const requireFromAgent = createRequire(join(repoRoot, "packages", "coding-agent", "package.json"));
	const entry = requireFromAgent.resolve("@anthropic-ai/claude-agent-sdk");
	const manifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as {
		claudeCodeVersion?: string;
	};
	if (!manifest.claudeCodeVersion) throw new Error("installed claude-agent-sdk has no claudeCodeVersion");
	return manifest.claudeCodeVersion;
}

function engineClaudeCodeVersionFloor(): string {
	const source = readFileSync(join(repoRoot, "packages", "ai", "src", "api", "anthropic-messages.ts"), "utf8");
	const match = /const claudeCodeVersion = "(\d+\.\d+\.\d+)";/.exec(source);
	if (!match?.[1]) throw new Error("anthropic-messages.ts has no claudeCodeVersion declaration");
	return match[1];
}

function bothInstalled(versions: { bundled?: string; onPath?: string }, overrides: Partial<ExecutableDeps> = {}) {
	const probed: string[] = [];
	const deps: ExecutableDeps = {
		platform: "darwin",
		arch: "arm64",
		env: (name) => (name === "PATH" ? "/usr/local/bin" : undefined),
		resolve: (spec) => `/sdk/${spec}`,
		isFile: (path) => path === SIDECAR || path === ON_PATH,
		bundledVersion: () => versions.bundled,
		versionOf: (executable) => {
			probed.push(executable);
			return executable === ON_PATH ? versions.onPath : versions.bundled;
		},
		...overrides,
	};
	return { deps, probed };
}

describe("regression #2033: the engine runs and advertises a current Claude Code", () => {
	it("floors the advertised Claude Code version at the one the pinned claude-agent-sdk ships", () => {
		expect(engineClaudeCodeVersionFloor()).toBe(installedSdkClaudeCodeVersion());
	});

	it("uses a newer claude on PATH instead of the bundled binary", () => {
		const { deps } = bothInstalled({ bundled: "2.1.280", onPath: "2.1.290" });
		expect(resolveClaudeCodeExecutable(deps)).toBe(ON_PATH);
	});

	it("keeps the bundled binary when claude on PATH is older", () => {
		const { deps } = bothInstalled({ bundled: "2.1.280", onPath: "2.1.260" });
		expect(resolveClaudeCodeExecutable(deps)).toBe(SIDECAR);
	});

	it("keeps the bundled binary on a tie", () => {
		const { deps } = bothInstalled({ bundled: "2.1.280", onPath: "2.1.280" });
		expect(resolveClaudeCodeExecutable(deps)).toBe(SIDECAR);
	});

	it("keeps the bundled binary when the PATH version cannot be read", () => {
		const { deps } = bothInstalled({ bundled: "2.1.280", onPath: undefined });
		expect(resolveClaudeCodeExecutable(deps)).toBe(SIDECAR);
	});

	it("probes the bundled binary itself when the SDK manifest names no version", () => {
		const { deps, probed } = bothInstalled(
			{ bundled: "2.1.280", onPath: "2.1.300" },
			{ bundledVersion: () => undefined },
		);
		expect(resolveClaudeCodeExecutable(deps)).toBe(ON_PATH);
		expect(probed).toContain(SIDECAR);
	});

	it("compares a compiled build's extracted binary against PATH the same way", () => {
		const extracted = "/tmp/extracted/claude";
		const { deps } = bothInstalled(
			{ bundled: "2.1.280", onPath: "2.1.281" },
			{
				isCompiledBun: () => true,
				extractFromBunfs: () => extracted,
				isFile: (path) => path === extracted || path === ON_PATH,
			},
		);
		expect(resolveClaudeCodeExecutable(deps)).toBe(ON_PATH);
	});

	it("never probes versions when CLAUDE_CODE_EXECUTABLE names a file", () => {
		const { deps, probed } = bothInstalled(
			{ bundled: "2.1.280", onPath: "2.1.290" },
			{
				env: (name) =>
					name === "CLAUDE_CODE_EXECUTABLE" ? "/custom/claude" : name === "PATH" ? "/usr/local/bin" : undefined,
				isFile: () => true,
			},
		);
		expect(resolveClaudeCodeExecutable(deps)).toBe("/custom/claude");
		expect(probed).toEqual([]);
	});
});
