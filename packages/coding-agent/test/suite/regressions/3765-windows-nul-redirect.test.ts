import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalBashOperations } from "../../../src/core/tools/bash.ts";
import { mapWindowsNulRedirects } from "../../../src/core/tools/windows-nul-redirect.ts";

// senpi#3765: Git Bash runs the bash tool on Windows and creates a literal `nul` file for a cmd.exe-style
// `2>nul`, which git cannot index. Platform contract: on win32 such redirects reach /dev/null.
const platform = Object.getOwnPropertyDescriptor(process, "platform");
const dirs: string[] = [];

afterEach(() => {
	if (platform) Object.defineProperty(process, "platform", platform);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("bash tool on Windows with a redirect to nul (#3765)", () => {
	it("leaves no nul file in the working directory", async () => {
		// given
		const cwd = mkdtempSync(join(tmpdir(), "senpi-3765-"));
		dirs.push(cwd);
		Object.defineProperty(process, "platform", { ...platform, value: "win32" });
		const operations = createLocalBashOperations({ shellPath: "/bin/bash" });
		let output = "";

		// when
		const result = await operations.exec("echo kept 2>nul; ls missing-path >NUL 2>&1; echo tail >>nul", cwd, {
			onData: (chunk) => {
				output += chunk.toString();
			},
		});

		// then
		expect(result.exitCode).toBe(0);
		expect(output).toContain("kept");
		expect(existsSync(join(cwd, "nul")) || existsSync(join(cwd, "NUL"))).toBe(false);
		expect(readdirSync(cwd)).toEqual([]);
	});
});

describe("mapWindowsNulRedirects", () => {
	it.each([
		["cmd 2>nul", "cmd 2>/dev/null"],
		["cmd >nul 2>&1", "cmd >/dev/null 2>&1"],
		["cmd > NUL", "cmd > /dev/null"],
		["cmd &>nul", "cmd &>/dev/null"],
		["cmd >>nul; next", "cmd >>/dev/null; next"],
		["cmd >|nul", "cmd >|/dev/null"],
		["cmd 2>&1 >nul|tee x", "cmd 2>&1 >/dev/null|tee x"],
	])("rewrites %j", (command, expected) => {
		expect(mapWindowsNulRedirects(command)).toBe(expected);
	});

	it.each([
		"echo '2>nul'",
		'echo "a >nul b"',
		"cmd >nullable",
		"cmd >nul.txt",
		"cmd <nul",
		"cmd 2>&1",
		"echo nul",
		"cmd # 2>nul",
		"cat <<EOF\n2>nul\nEOF",
	])("leaves %j unchanged", (command) => {
		expect(mapWindowsNulRedirects(command)).toBe(command);
	});
});
