import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	defaultExecutableDeps,
	describeClaudeCodeExecutable,
} from "../src/core/extensions/builtin/anthropic-subscription/executable.ts";
import { probeClaudeCodeVersion } from "../src/core/extensions/builtin/anthropic-subscription/executable-version.ts";

// omo#8700: npm installs Claude Code on Windows as %APPDATA%\npm\claude.cmd around bin\claude.exe.
// Real files on a real Windows host: the shim must resolve to a native binary this runtime can spawn.

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function npmGlobalWithShim(): { bin: string; target: string } {
	const bin = mkdtempSync(join(tmpdir(), "senpi-8700-npm-"));
	roots.push(bin);
	const packageBin = join(bin, "node_modules", "@anthropic-ai", "claude-code", "bin");
	mkdirSync(packageBin, { recursive: true });
	const target = join(packageBin, "claude.exe");
	copyFileSync(process.execPath, target);
	writeFileSync(
		join(bin, "claude.cmd"),
		'@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n',
	);
	return { bin, target };
}

describe.runIf(process.platform === "win32")("Claude Code on Windows PATH via an npm cmd-shim (omo#8700)", () => {
	it("resolves claude.cmd to the native claude.exe and reads its version", () => {
		const { bin, target } = npmGlobalWithShim();
		const resolution = describeClaudeCodeExecutable({
			...defaultExecutableDeps(),
			env: (name) => (name === "PATH" ? bin : name === "PATHEXT" ? ".COM;.EXE;.BAT;.CMD" : undefined),
			resolve: () => {
				throw new Error("no bundled platform package in this test");
			},
			isCompiledBun: () => false,
		});

		expect(resolution.source).toBe("path");
		expect(resolution.executable?.toLowerCase().endsWith(target.toLowerCase())).toBe(true);
		expect(probeClaudeCodeVersion(resolution.executable ?? "")).toMatch(/^\d+\.\d+\.\d+$/);
	});
});
