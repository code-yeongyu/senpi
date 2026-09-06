import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	expandHome,
	extractExternalPaths,
	isExternalPath,
} from "../../src/core/extensions/builtin/permission-system/external-dir.ts";

const openingSyscalls = vi.hoisted(() => [] as string[]);

function recordOpeningCall(name: string, actualFn: unknown): unknown {
	return (...args: unknown[]): unknown => {
		openingSyscalls.push(name);
		return (actualFn as (...forwarded: unknown[]) => unknown)(...args);
	};
}

vi.mock("node:fs", async (importOriginal) => {
	const actual = (await importOriginal()) as typeof fs;
	return {
		...actual,
		realpathSync: Object.assign(
			recordOpeningCall("realpathSync", actual.realpathSync) as typeof actual.realpathSync,
			{
				native: recordOpeningCall(
					"realpathSync.native",
					actual.realpathSync.native,
				) as typeof actual.realpathSync.native,
			},
		),
		statSync: recordOpeningCall("statSync", actual.statSync) as typeof actual.statSync,
		existsSync: recordOpeningCall("existsSync", actual.existsSync) as typeof actual.existsSync,
	};
});

describe("external-dir", () => {
	describe("expandHome", () => {
		it("expands ~ to home directory", () => {
			const input = "~";
			const result = expandHome(input);
			expect(result).toBe(os.homedir());
		});

		it("expands ~/path to home directory + path", () => {
			const input = "~/projects/my-app";
			const result = expandHome(input);
			expect(result).toBe(path.join(os.homedir(), "projects/my-app"));
		});

		it("expands ~\\path for Windows-style paths", () => {
			const input = "~\\projects\\my-app";
			const result = expandHome(input);
			expect(result).toBe(path.join(os.homedir(), "projects\\my-app"));
		});

		it("expands $HOME to home directory", () => {
			const input = "$HOME";
			const result = expandHome(input);
			expect(result).toBe(os.homedir());
		});

		it("expands $HOME/path to home directory + path", () => {
			const input = "$HOME/projects/my-app";
			const result = expandHome(input);
			expect(result).toBe(path.join(os.homedir(), "projects/my-app"));
		});

		it("expands $HOME\\path for Windows-style paths", () => {
			const input = "$HOME\\projects\\my-app";
			const result = expandHome(input);
			expect(result).toBe(path.join(os.homedir(), "projects\\my-app"));
		});

		it("returns non-home paths unchanged", () => {
			const input = "/usr/local/bin";
			const result = expandHome(input);
			expect(result).toBe("/usr/local/bin");
		});

		it("returns relative paths unchanged", () => {
			const input = "./src/file.ts";
			const result = expandHome(input);
			expect(result).toBe("./src/file.ts");
		});
	});

	describe("isExternalPath", () => {
		it("returns false for paths inside cwd", () => {
			const cwd = "/Users/me/project";
			const target = "/Users/me/project/src/file.ts";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(false);
		});

		it("returns false for relative paths inside cwd", () => {
			const cwd = "/Users/me/project";
			const target = "./src/file.ts";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(false);
		});

		it("returns false for relative paths without prefix inside cwd", () => {
			const cwd = "/Users/me/project";
			const target = "src/file.ts";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(false);
		});

		it("returns true for absolute paths outside cwd", () => {
			const cwd = "/Users/me/project";
			const target = "/Users/other/project";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(true);
		});

		it("returns true for relative paths going outside cwd", () => {
			const cwd = "/Users/me/project";
			const target = "../sibling";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(true);
		});

		it("returns true for deeply nested relative paths going outside cwd", () => {
			const cwd = "/Users/me/project";
			const target = "../../other/project";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(true);
		});

		it("returns false for cwd itself", () => {
			const cwd = "/Users/me/project";
			const target = "/Users/me/project";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(false);
		});

		it("returns false for cwd as relative path", () => {
			const cwd = "/Users/me/project";
			const target = ".";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(false);
		});

		it("handles ~ expansion correctly when inside home", () => {
			const cwd = path.join(os.homedir(), "project");
			const target = "~/project/src/file.ts";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(false);
		});

		it("handles ~ expansion correctly when outside home project", () => {
			const cwd = path.join(os.homedir(), "project");
			const target = "~/other-project";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(true);
		});

		it("handles $HOME expansion correctly when inside home", () => {
			const cwd = path.join(os.homedir(), "project");
			const target = "$HOME/project/src/file.ts";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(false);
		});

		it("handles $HOME expansion correctly when outside home project", () => {
			const cwd = path.join(os.homedir(), "project");
			const target = "$HOME/other-project";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(true);
		});

		it("handles symlinks by resolving them", () => {
			const cwd = "/Users/me/project";
			const target = "/Users/me/project/src/../config";
			const result = isExternalPath(target, cwd);
			expect(result).toBe(false);
		});

		it.skipIf(process.platform === "win32")("keeps relative non-existent paths inside a symlinked cwd", () => {
			const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), "external-dir-real-"));
			const linkRoot = path.join(os.tmpdir(), `external-dir-link-${process.pid}-${Date.now()}`);
			fs.symlinkSync(realRoot, linkRoot, "dir");
			try {
				expect(isExternalPath("src/new.ts", linkRoot)).toBe(false);
			} finally {
				fs.rmSync(linkRoot, { force: true });
				fs.rmSync(realRoot, { recursive: true, force: true });
			}
		});
	});

	describe("extractExternalPaths", () => {
		it("returns empty array for commands with no paths", () => {
			const cwd = "/Users/me/project";
			const command = "ls -la";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual([]);
		});

		it("detects external absolute paths", () => {
			const cwd = "/Users/me/project";
			const command = "cat /Users/other/project/file.txt";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["/Users/other/project/file.txt"]);
		});

		it("detects external relative paths", () => {
			const cwd = "/Users/me/project";
			const command = "cat ../sibling/file.txt";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["../sibling/file.txt"]);
		});

		it("ignores internal paths", () => {
			const cwd = "/Users/me/project";
			const command = "cat ./src/file.ts src/utils.ts";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual([]);
		});

		it("detects external paths with ~ expansion", () => {
			const cwd = path.join(os.homedir(), "project");
			const command = "cat ~/other-project/file.txt";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["~/other-project/file.txt"]);
		});

		it("detects external paths with $HOME expansion", () => {
			const cwd = path.join(os.homedir(), "project");
			const command = "cat $HOME/other-project/file.txt";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["$HOME/other-project/file.txt"]);
		});

		it("handles quoted paths", () => {
			const cwd = "/Users/me/project";
			const command = 'cat "/Users/other/project/file with spaces.txt"';
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["/Users/other/project/file with spaces.txt"]);
		});

		it("handles multiple external paths", () => {
			const cwd = "/Users/me/project";
			const command = "cp /Users/other/file1.txt /Users/other/file2.txt .";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["/Users/other/file1.txt", "/Users/other/file2.txt"]);
		});

		it("ignores flags", () => {
			const cwd = "/Users/me/project";
			const command = "ls -la --color=auto /Users/other/project";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["/Users/other/project"]);
		});

		it("ignores environment variable assignments", () => {
			const cwd = "/Users/me/project";
			const command = "ENV_VAR=value cat file.txt";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual([]);
		});

		it("handles mixed internal and external paths", () => {
			const cwd = "/Users/me/project";
			const command = "cp ./internal.txt /Users/external/file.txt";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["/Users/external/file.txt"]);
		});

		it("handles complex bash commands", () => {
			const cwd = "/Users/me/project";
			const command = "cat /etc/passwd | grep root > /Users/other/output.txt";
			const result = extractExternalPaths(command, cwd);
			expect(result).toContain("/etc/passwd");
			expect(result).toContain("/Users/other/output.txt");
		});

		it("handles mkdir command with external path", () => {
			const cwd = "/Users/me/project";
			const command = "mkdir -p /Users/other/new-dir";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["/Users/other/new-dir"]);
		});

		it("handles touch command with external path", () => {
			const cwd = "/Users/me/project";
			const command = "touch /Users/other/file.txt";
			const result = extractExternalPaths(command, cwd);
			expect(result).toEqual(["/Users/other/file.txt"]);
		});
	});

	// Regression coverage for https://github.com/code-yeongyu/senpi/issues/1416
	describe("path resolution never opens the classified path", () => {
		beforeEach(() => {
			openingSyscalls.length = 0;
		});

		it("classifies paths without realpathSync, statSync, or existsSync", () => {
			expect(isExternalPath("/Users/other/deeply/nested/missing.txt", "/Users/me/project")).toBe(true);
			expect(extractExternalPaths("bash /home/user/work/poll-fdl.sh", "/Users/me/project")).toEqual([
				"/home/user/work/poll-fdl.sh",
			]);

			expect(openingSyscalls).toEqual([]);
		});

		it.skipIf(process.platform === "win32")("still resolves symlinked components", () => {
			const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "external-dir-walk-real-")));
			const linkRoot = path.join(os.tmpdir(), `external-dir-walk-link-${process.pid}-${Date.now()}`);
			fs.mkdirSync(path.join(realRoot, "nested"));
			fs.symlinkSync(realRoot, linkRoot, "dir");
			openingSyscalls.length = 0;
			try {
				expect(isExternalPath(path.join(linkRoot, "nested", "missing.ts"), path.join(realRoot, "nested"))).toBe(
					false,
				);
				expect(openingSyscalls).toEqual([]);
			} finally {
				fs.rmSync(linkRoot, { force: true });
				fs.rmSync(realRoot, { recursive: true, force: true });
			}
		});

		it.skipIf(process.platform === "win32")("follows a chain of symlinks to the same real directory", () => {
			const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "external-dir-chain-real-")));
			const firstLink = path.join(os.tmpdir(), `external-dir-chain-a-${process.pid}-${Date.now()}`);
			const secondLink = path.join(os.tmpdir(), `external-dir-chain-b-${process.pid}-${Date.now()}`);
			fs.symlinkSync(realRoot, firstLink, "dir");
			fs.symlinkSync(firstLink, secondLink, "dir");
			try {
				expect(isExternalPath(path.join(secondLink, "src", "missing.ts"), realRoot)).toBe(false);
			} finally {
				fs.rmSync(secondLink, { force: true });
				fs.rmSync(firstLink, { force: true });
				fs.rmSync(realRoot, { recursive: true, force: true });
			}
		});

		it.skipIf(process.platform === "win32")("returns a verdict for a symlink cycle instead of hanging", () => {
			const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "external-dir-loop-")));
			fs.symlinkSync(path.join(realRoot, "b"), path.join(realRoot, "a"), "dir");
			fs.symlinkSync(path.join(realRoot, "a"), path.join(realRoot, "b"), "dir");
			openingSyscalls.length = 0;
			try {
				expect(isExternalPath(path.join(realRoot, "a", "file.txt"), realRoot)).toBe(false);
				expect(openingSyscalls).toEqual([]);
			} finally {
				fs.rmSync(realRoot, { recursive: true, force: true });
			}
		});

		it.skipIf(process.platform === "win32")("treats a backslash as a filename character on posix", () => {
			expect(isExternalPath("/tmp/project\\outside/file", "/tmp/project")).toBe(true);
			expect(extractExternalPaths("cat /tmp/project\\outside/file", "/tmp/project")).toEqual([
				"/tmp/project\\outside/file",
			]);
		});

		it.skipIf(process.platform === "win32")("keeps non-existent trailing components verbatim", () => {
			const realRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "external-dir-tail-")));
			try {
				expect(isExternalPath(path.join(realRoot, "a", "b", "c.txt"), realRoot)).toBe(false);
				expect(isExternalPath(path.join(realRoot, "..", "elsewhere", "c.txt"), realRoot)).toBe(true);
			} finally {
				fs.rmSync(realRoot, { recursive: true, force: true });
			}
		});
	});
});
