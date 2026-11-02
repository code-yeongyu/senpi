import { describe, expect, it } from "vitest";
import {
	findExecutableOnPath,
	type PathLookupDeps,
} from "../src/core/extensions/builtin/anthropic-subscription/executable-path-lookup.ts";

/**
 * code-yeongyu/senpi#1541 item 3: the PATH fallback is what `where claude` / `command -v claude`
 * prints - a regular file, found without a shell, honouring PATHEXT on win32.
 */

function deps(overrides: Partial<PathLookupDeps>): PathLookupDeps {
	return { platform: "linux", env: () => undefined, isFile: () => false, ...overrides };
}

function envOf(values: Record<string, string>): PathLookupDeps["env"] {
	return (name) => values[name];
}

describe("findExecutableOnPath", () => {
	it("returns undefined when PATH is unset", () => {
		expect(findExecutableOnPath("claude", deps({ isFile: () => true }))).toBeUndefined();
	});

	it("walks PATH in order on posix and returns the first regular file", () => {
		const probed: string[] = [];
		const found = findExecutableOnPath(
			"claude",
			deps({
				env: envOf({ PATH: "/usr/bin::/home/u/.local/bin:/usr/local/bin" }),
				isFile: (path) => {
					probed.push(path);
					return path === "/home/u/.local/bin/claude";
				},
			}),
		);
		expect(found).toBe("/home/u/.local/bin/claude");
		expect(probed).toEqual(["/usr/bin/claude", "/home/u/.local/bin/claude"]);
	});

	it("skips PATH entries that are directories or missing (files only)", () => {
		const found = findExecutableOnPath(
			"claude",
			deps({ env: envOf({ PATH: "/opt/claude:/usr/bin" }), isFile: (path) => path === "/usr/bin/claude" }),
		);
		expect(found).toBe("/usr/bin/claude");
	});

	it("honours PATHEXT order within each directory on win32", () => {
		const probed: string[] = [];
		const found = findExecutableOnPath(
			"claude",
			deps({
				platform: "win32",
				env: envOf({ PATH: "C:\\Windows\\System32;C:\\Users\\u\\.local\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD" }),
				isFile: (path) => {
					probed.push(path);
					return path === "C:\\Users\\u\\.local\\bin\\claude.exe";
				},
			}),
		);
		expect(found).toBe("C:\\Users\\u\\.local\\bin\\claude.exe");
		expect(probed).toEqual([
			"C:\\Windows\\System32\\claude.com",
			"C:\\Windows\\System32\\claude.exe",
			"C:\\Windows\\System32\\claude.bat",
			"C:\\Windows\\System32\\claude.cmd",
			"C:\\Users\\u\\.local\\bin\\claude.com",
			"C:\\Users\\u\\.local\\bin\\claude.exe",
		]);
	});

	it("resolves an npm claude.cmd shim to the native claude.exe it wraps on win32 (omo#8700)", () => {
		const shim = "C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd";
		const target = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
		const found = findExecutableOnPath(
			"claude",
			deps({
				platform: "win32",
				env: envOf({ PATH: "C:\\Users\\u\\AppData\\Roaming\\npm" }),
				isFile: (path) => path === shim || path === target,
				readText: (path) =>
					path === shim
						? '@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n'
						: undefined,
			}),
		);
		expect(found).toBe(target);
	});

	it("skips a batch file that wraps no native binary and keeps searching PATH", () => {
		const skipped: string[] = [];
		const found = findExecutableOnPath(
			"claude",
			deps({
				platform: "win32",
				env: envOf({ PATH: "C:\\tools;C:\\Users\\u\\.local\\bin" }),
				isFile: (path) => path === "C:\\tools\\claude.cmd" || path === "C:\\Users\\u\\.local\\bin\\claude.exe",
				readText: () => "@node %~dp0\\cli.js %*",
				onSkip: (path) => skipped.push(path),
			}),
		);
		expect(found).toBe("C:\\Users\\u\\.local\\bin\\claude.exe");
		expect(skipped).toEqual(["C:\\tools\\claude.cmd"]);
	});

	it("never returns a batch file when its text cannot be read", () => {
		const found = findExecutableOnPath(
			"claude",
			deps({
				platform: "win32",
				env: envOf({ PATH: "C:\\tools" }),
				isFile: (path) => path === "C:\\tools\\claude.cmd",
			}),
		);
		expect(found).toBeUndefined();
	});

	it("falls back to the Windows default PATHEXT and strips quoted PATH entries", () => {
		const probed: string[] = [];
		const found = findExecutableOnPath(
			"claude",
			deps({
				platform: "win32",
				env: envOf({ PATH: '"C:\\Program Files\\Claude"' }),
				isFile: (path) => {
					probed.push(path);
					return path.endsWith("\\claude.exe");
				},
			}),
		);
		expect(found).toBe("C:\\Program Files\\Claude\\claude.exe");
		expect(probed).toEqual(["C:\\Program Files\\Claude\\claude.com", "C:\\Program Files\\Claude\\claude.exe"]);
	});
});
