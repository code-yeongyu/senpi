import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
	describeClaudeCodeExecutable,
	type ExecutableDeps,
} from "../src/core/extensions/builtin/anthropic-subscription/executable.ts";

// A compiled engine bundles the SDK, so resolving the SDK's platform package from inside the
// binary always fails; the platform package can only sit on disk next to the executable.
function compiledDeps(overrides: Partial<ExecutableDeps>): ExecutableDeps {
	return {
		platform: "darwin",
		arch: "arm64",
		env: () => undefined,
		resolve: () => {
			throw new Error("Cannot find package '@anthropic-ai/claude-agent-sdk' imported from /$bunfs/root/omo");
		},
		isFile: () => false,
		isCompiledBun: () => true,
		extractFromBunfs: () => {
			throw new Error("not embedded");
		},
		...overrides,
	};
}

describe("a compiled build's sidecar Claude Code beside the executable", () => {
	const engineDir = "/Applications/OmO.app/Contents/Resources/omo-runtime/darwin-arm64";
	const sidecar = posix.join(engineDir, "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude");

	it("is found as the bundled binary when the SDK cannot resolve its platform package", () => {
		const resolution = describeClaudeCodeExecutable(
			compiledDeps({ executableDir: () => engineDir, isFile: (path) => path === sidecar }),
		);
		expect(resolution.executable).toBe(sidecar);
		expect(resolution.source).toBe("bundled");
	});

	it("still yields to a strictly newer claude on PATH", () => {
		const onPath = "/usr/local/bin/claude";
		const resolution = describeClaudeCodeExecutable(
			compiledDeps({
				executableDir: () => engineDir,
				env: (name) => (name === "PATH" ? "/usr/local/bin" : undefined),
				isFile: (path) => path === sidecar || path === onPath,
				versionOf: (path) => (path === onPath ? "9.9.9" : "2.1.0"),
			}),
		);
		expect(resolution.executable).toBe(onPath);
		expect(resolution.source).toBe("path");
	});

	it("is found on win32 under a non-ASCII user folder, in the namespaced form the SDK spawns", () => {
		const dir = "C:\\Users\\홍길동\\AppData\\Local\\Programs\\omo\\resources\\omo-runtime\\windows-x64";
		const expected = win32.toNamespacedPath(
			win32.join(dir, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe"),
		);
		const resolution = describeClaudeCodeExecutable(
			compiledDeps({
				platform: "win32",
				arch: "x64",
				executableDir: () => dir,
				isFile: (path) => path === expected,
			}),
		);
		expect(resolution.executable).toBe(expected);
		expect(resolution.source).toBe("bundled");
	});

	it("is not consulted by a build that is not compiled", () => {
		const resolution = describeClaudeCodeExecutable(
			compiledDeps({
				isCompiledBun: () => false,
				executableDir: () => engineDir,
				isFile: (path) => path === sidecar,
			}),
		);
		expect(resolution.executable).toBeUndefined();
	});
});
