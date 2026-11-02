import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ExecFileProbe } from "../src/interpreters/detect.ts";
import { createInterpreterDetector } from "../src/interpreters/detect.ts";
import { resolveCommandPath } from "../src/interpreters/resolve-command.ts";

function stubProbe(outputs: ReadonlyMap<string, string>): ExecFileProbe {
	return async (command, args) => {
		const value = outputs.get([command, ...args].join(" "));
		if (typeof value !== "string") throw new Error("missing command");
		return { stdout: value, stderr: "" };
	};
}

describe("interpreter detection resolved path", () => {
	it("attaches the resolved absolute executable path to detections", async () => {
		const detector = createInterpreterDetector({
			platform: "linux",
			execFile: stubProbe(new Map([["python3 --version", "Python 3.14.7"]])),
			resolveCommandPath: (command) => (command === "python3" ? "/opt/homebrew/bin/python3" : undefined),
		});

		await expect(detector.detect("py")).resolves.toEqual({
			ok: true,
			path: "python3",
			version: "3.14.7",
			resolvedPath: "/opt/homebrew/bin/python3",
		});
	});

	it("omits resolvedPath when the command cannot be resolved", async () => {
		const detector = createInterpreterDetector({
			platform: "linux",
			execFile: stubProbe(new Map([["ruby --version", "ruby 3.3.6"]])),
			resolveCommandPath: () => undefined,
		});

		await expect(detector.detect("rb")).resolves.toEqual({ ok: true, path: "ruby", version: "3.3.6" });
	});

	it("resolves multi-word candidates through the bare command", async () => {
		const seen: string[] = [];
		const detector = createInterpreterDetector({
			platform: "win32",
			execFile: stubProbe(
				new Map([
					["python --version", ""],
					["py -3 --version", "Python 3.12.4"],
				]),
			),
			resolveCommandPath: (command) => {
				seen.push(command);
				return command === "py" ? "C:\\Windows\\py.exe" : undefined;
			},
		});

		await expect(detector.detect("py")).resolves.toEqual({
			ok: true,
			path: "py -3",
			version: "3.12.4",
			resolvedPath: "C:\\Windows\\py.exe",
		});
		expect(seen).toContain("py");
	});
});

describe("resolveCommandPath", () => {
	const dir = mkdtempSync(join(tmpdir(), "senpi-resolve-"));
	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("finds an executable on PATH and returns its absolute path", () => {
		const target = join(dir, "fake-interpreter");
		writeFileSync(target, "#!/bin/sh\n");
		chmodSync(target, 0o755);
		expect(resolveCommandPath("fake-interpreter", { env: { PATH: dir }, platform: "darwin" })).toBe(target);
	});

	it("returns undefined for a missing command", () => {
		expect(resolveCommandPath("definitely-missing-tool", { env: { PATH: dir }, platform: "darwin" })).toBeUndefined();
	});

	it("skips non-executable files on posix", () => {
		const target = join(dir, "not-executable");
		writeFileSync(target, "");
		chmodSync(target, 0o644);
		expect(resolveCommandPath("not-executable", { env: { PATH: dir }, platform: "darwin" })).toBeUndefined();
	});

	it("matches Windows PATHEXT candidates", () => {
		const winDir = join(dir, "win");
		mkdirSync(winDir);
		writeFileSync(join(winDir, "tool.exe"), "");
		expect(resolveCommandPath("tool", { env: { PATH: winDir, PATHEXT: ".COM;.EXE" }, platform: "win32" })).toBe(
			join(winDir, "tool.exe"),
		);
	});
});
