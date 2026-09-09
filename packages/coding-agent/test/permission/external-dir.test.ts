import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	expandHome,
	extractExternalPaths,
	isExternalPath,
} from "../../src/core/extensions/builtin/permission-system/external-dir.ts";

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
});
