import { describe, expect, it } from "vitest";
import {
	findExecutableOnPath,
	type PathLookupDeps,
} from "../src/core/extensions/builtin/claude-sdk-oauth/executable-path-lookup.ts";

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
