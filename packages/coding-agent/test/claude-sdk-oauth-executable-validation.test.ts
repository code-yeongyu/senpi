import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import {
	defaultExecutableDeps,
	describeClaudeCodeExecutable,
	type ExecutableDeps,
	resolveClaudeCodeExecutable,
} from "../src/core/extensions/builtin/claude-sdk-oauth/executable.ts";

/**
 * code-yeongyu/senpi#1541: the string handed to the SDK's `pathToClaudeCodeExecutable` must name a
 * regular file THIS process can stat, spelled the way `CreateProcess`/`uv` accept it. A resolvable
 * package that is not spawnable is skipped, `claude` on PATH is the last resort, and a total miss
 * is senpi's own error naming every candidate tried.
 */

const WIN_SIDECAR = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\omo-ai\\node_modules\\@anthropic-ai";

function makeDeps(overrides: Partial<ExecutableDeps>): ExecutableDeps {
	return {
		platform: "darwin",
		arch: "arm64",
		env: () => undefined,
		resolve: () => {
			throw new Error("not found");
		},
		isFile: () => true,
		...overrides,
	};
}

function envOf(values: Record<string, string>): ExecutableDeps["env"] {
	return (name) => values[name];
}

describe("resolveClaudeCodeExecutable validates every candidate (#1541)", () => {
	it("skips a package that resolves but is not a file and takes the next package", () => {
		const deps = makeDeps({
			platform: "linux",
			arch: "x64",
			isMusl: () => false,
			resolve: (spec) => `/resolved/${spec}`,
			isFile: (path) => path.includes("musl"),
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/resolved/@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude");
	});

	it("falls back to claude on PATH when the resolved package is not a file", () => {
		const deps = makeDeps({
			env: envOf({ PATH: "/opt/missing:/usr/local/bin" }),
			resolve: (spec) => `/resolved/${spec}`,
			isFile: (path) => path === "/usr/local/bin/claude",
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/usr/local/bin/claude");
	});

	it("falls back to claude on PATH when no package resolves at all", () => {
		const deps = makeDeps({
			env: envOf({ PATH: "/usr/local/bin" }),
			isFile: (path) => path === "/usr/local/bin/claude",
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/usr/local/bin/claude");
	});

	it("hands the SDK the \\\\?\\ namespaced absolute spelling on win32 and validates that spelling", () => {
		const plain = `${WIN_SIDECAR}\\claude-agent-sdk-win32-x64\\claude.exe`;
		const namespaced = `\\\\?\\${plain}`;
		const checked: string[] = [];
		const deps = makeDeps({
			platform: "win32",
			arch: "x64",
			resolve: () => plain,
			isFile: (path) => {
				checked.push(path);
				return path === namespaced;
			},
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe(namespaced);
		expect(checked).toEqual([namespaced]);
	});

	it("uses claude.exe from PATH on win32 when the hoisted sidecar cannot be stat'ed", () => {
		const onPath = "C:\\Users\\u\\.local\\bin\\claude.exe";
		const deps = makeDeps({
			platform: "win32",
			arch: "x64",
			env: envOf({ PATH: "C:\\Windows\\System32;C:\\Users\\u\\.local\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" }),
			resolve: () => `${WIN_SIDECAR}\\claude-agent-sdk-win32-x64\\claude.exe`,
			isFile: (path) => path === onPath || path === `\\\\?\\${onPath}`,
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe(`\\\\?\\${onPath}`);
	});

	it("rejects CLAUDE_CODE_EXECUTABLE that is not a file and continues to the package", () => {
		const deps = makeDeps({
			env: envOf({ CLAUDE_CODE_EXECUTABLE: "/custom/claude" }),
			resolve: (spec) => `/resolved/${spec}`,
			isFile: (path) => path !== "/custom/claude",
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/resolved/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
	});

	it("still honours a CLAUDE_CODE_EXECUTABLE that names a file, absolute and namespaced on win32", () => {
		const deps = makeDeps({
			platform: "win32",
			arch: "x64",
			env: envOf({ CLAUDE_CODE_EXECUTABLE: "D:\\tools\\claude.exe" }),
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("\\\\?\\D:\\tools\\claude.exe");
	});

	it("validates the compiled-Bun extraction result before using it", () => {
		const deps = makeDeps({
			isCompiledBun: () => true,
			extractFromBunfs: () => "/tmp/extracted/claude",
			resolve: (spec) => `/on-disk/${spec}`,
			isFile: (path) => path.startsWith("/on-disk/"),
		});
		expect(resolveClaudeCodeExecutable(deps)).toBe("/on-disk/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");
	});

	it("names every candidate it tried when nothing is spawnable", () => {
		const deps = makeDeps({
			platform: "win32",
			arch: "x64",
			env: envOf({ CLAUDE_CODE_EXECUTABLE: "C:\\custom\\claude.exe", PATH: "C:\\bin" }),
			resolve: () => `${WIN_SIDECAR}\\claude-agent-sdk-win32-x64\\claude.exe`,
			isFile: () => false,
		});
		const described = describeClaudeCodeExecutable(deps);
		expect(described.executable).toBeUndefined();
		expect(described.tried).toEqual([
			"\\\\?\\C:\\custom\\claude.exe",
			`\\\\?\\${WIN_SIDECAR}\\claude-agent-sdk-win32-x64\\claude.exe`,
			"claude on PATH",
		]);
		expect(() => resolveClaudeCodeExecutable(deps)).toThrowError(
			/win32-x64[\s\S]*\\\\\?\\C:\\custom\\claude\.exe[\s\S]*claude-agent-sdk-win32-x64\\claude\.exe[\s\S]*claude on PATH[\s\S]*--omit=optional[\s\S]*CLAUDE_CODE_EXECUTABLE/,
		);
	});

	it("lists an unresolvable package by its specifier", () => {
		const described = describeClaudeCodeExecutable(
			makeDeps({ platform: "linux", arch: "arm64", isFile: () => false }),
		);
		expect(described.executable).toBeUndefined();
		expect(described.tried).toEqual([
			"@anthropic-ai/claude-agent-sdk-linux-arm64/claude",
			"@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude",
			"claude on PATH (PATH is unset)",
		]);
	});
});

describe("defaultExecutableDeps", () => {
	// Item 1 of #1541: `require` is rooted at the SDK instance this extension imports and walks its
	// parents, so the installed sidecar is found whether it sits beside the SDK or hoisted above it.
	// The env is blanked so neither CLAUDE_CODE_EXECUTABLE nor PATH on the host can stand in.
	it("resolves the installed sidecar of the imported SDK to a file this process can stat", () => {
		const resolution = describeClaudeCodeExecutable({ ...defaultExecutableDeps(), env: () => undefined });
		const executable = resolution.executable;
		expect(executable, resolution.tried.join("\n")).toBeDefined();
		if (executable === undefined) return;
		expect(isAbsolute(executable)).toBe(true);
		expect(executable).toMatch(
			new RegExp(`claude-agent-sdk-${process.platform}-${process.arch}(-musl)?[\\\\/]claude(\\.exe)?$`),
		);
		expect(statSync(executable).isFile()).toBe(true);
	});
});
