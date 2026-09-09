import { describe, expect, it } from "vitest";
import {
	claudeCodeExecutableCandidates,
	type ExecutableDeps,
	resolveClaudeCodeExecutable,
} from "../src/core/extensions/builtin/claude-sdk-oauth/executable.ts";

function makeDeps(overrides: Partial<ExecutableDeps>): ExecutableDeps {
	return {
		platform: "darwin",
		arch: "arm64",
		env: () => undefined,
		resolve: () => {
			throw new Error("not found");
		},
		...overrides,
	};
}

describe("claudeCodeExecutableCandidates", () => {
	it("uses the platform/arch package on darwin-arm64", () => {
		expect(claudeCodeExecutableCandidates("darwin", "arm64")).toEqual([
			"@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
		]);
	});

	it("uses the platform/arch package on darwin-x64", () => {
		expect(claudeCodeExecutableCandidates("darwin", "x64")).toEqual([
			"@anthropic-ai/claude-agent-sdk-darwin-x64/claude",
		]);
	});

	it("tries glibc first, then musl on linux-x64 by default", () => {
		expect(claudeCodeExecutableCandidates("linux", "x64")).toEqual([
			"@anthropic-ai/claude-agent-sdk-linux-x64/claude",
			"@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
		]);
	});

	it("tries musl first, then glibc on a musl linux-arm64 host", () => {
		expect(claudeCodeExecutableCandidates("linux", "arm64", true)).toEqual([
			"@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude",
			"@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
		]);
	});

	it("appends .exe on win32", () => {
		expect(claudeCodeExecutableCandidates("win32", "x64")).toEqual([
			"@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe",
		]);
	});
});

describe("resolveClaudeCodeExecutable", () => {
	it("honors CLAUDE_CODE_EXECUTABLE before anything else", () => {
		const deps = makeDeps({
			env: (name) => (name === "CLAUDE_CODE_EXECUTABLE" ? "/custom/claude" : undefined),
			isMusl: () => {
				throw new Error("must not detect libc when overridden");
			},
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/custom/claude");
	});

	it("prefers glibc on a glibc Linux host", () => {
		const seen: string[] = [];
		const deps = makeDeps({
			platform: "linux",
			arch: "x64",
			isMusl: () => false,
			resolve: (spec) => {
				seen.push(spec);
				return `/resolved/${spec}`;
			},
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/resolved/@anthropic-ai/claude-agent-sdk-linux-x64/claude");
		expect(seen).toEqual(["@anthropic-ai/claude-agent-sdk-linux-x64/claude"]);
	});

	it("prefers musl on a musl Linux host", () => {
		const deps = makeDeps({
			platform: "linux",
			arch: "arm64",
			isMusl: () => true,
			resolve: (spec) => `/resolved/${spec}`,
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe(
			"/resolved/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude",
		);
	});

	it("defaults to glibc when libc detection is inconclusive", () => {
		const deps = makeDeps({
			platform: "linux",
			arch: "x64",
			resolve: (spec) => `/resolved/${spec}`,
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/resolved/@anthropic-ai/claude-agent-sdk-linux-x64/claude");
	});

	it("falls back to musl when only that Linux package is installed", () => {
		const seen: string[] = [];
		const deps = makeDeps({
			platform: "linux",
			arch: "x64",
			isMusl: () => false,
			resolve: (spec) => {
				seen.push(spec);
				if (!spec.includes("musl")) throw new Error("not found");
				return `/resolved/${spec}`;
			},
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/resolved/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude");
		expect(seen).toEqual([
			"@anthropic-ai/claude-agent-sdk-linux-x64/claude",
			"@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
		]);
	});

	it("falls back to glibc when only that Linux package is installed", () => {
		const seen: string[] = [];
		const deps = makeDeps({
			platform: "linux",
			arch: "x64",
			isMusl: () => true,
			resolve: (spec) => {
				seen.push(spec);
				if (spec.includes("musl")) throw new Error("not found");
				return `/resolved/${spec}`;
			},
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/resolved/@anthropic-ai/claude-agent-sdk-linux-x64/claude");
		expect(seen).toEqual([
			"@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude",
			"@anthropic-ai/claude-agent-sdk-linux-x64/claude",
		]);
	});

	it("prefers the compiled-Bun extraction lane when running compiled", () => {
		const deps = makeDeps({
			isCompiledBun: () => true,
			extractFromBunfs: (embedded) => `/extracted${embedded}`,
			resolve: (spec) => `/embedded/${spec}`,
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe(
			"/extracted/embedded/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
		);
	});

	it("falls back to the node_modules probe when extraction throws", () => {
		const deps = makeDeps({
			isCompiledBun: () => true,
			extractFromBunfs: () => {
				throw new Error("not embedded");
			},
			resolve: (spec) => `/resolved/${spec}`,
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/resolved/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
	});

	it("throws guidance naming both remedies when nothing resolves", () => {
		const deps = makeDeps({ platform: "linux", arch: "arm64" });
		expect(() => resolveClaudeCodeExecutable(deps)).toThrowError(/--omit=optional[\s\S]*CLAUDE_CODE_EXECUTABLE/);
	});
});
