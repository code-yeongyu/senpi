import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getToolPath } from "../src/utils/tools-manager.ts";

describe("PATH probe for managed tools", () => {
	let pathRoot: string;
	let originalPath: string | undefined;

	beforeEach(() => {
		pathRoot = mkdtempSync(join(tmpdir(), "senpi-path-probe-"));
		originalPath = process.env.PATH;
	});

	afterEach(() => {
		if (originalPath === undefined) delete process.env.PATH;
		else process.env.PATH = originalPath;
		rmSync(pathRoot, { force: true, recursive: true });
	});

	const writeCandidate = (name: string, mode: number): string => {
		const binDir = join(pathRoot, "bin");
		mkdirSync(binDir, { recursive: true });
		const file = join(binDir, name);
		writeFileSync(file, "#!/bin/sh\nexit 0\n");
		chmodSync(file, mode);
		return binDir;
	};

	test("#given an executable on PATH #when the tool is resolved #then the command name is returned", () => {
		// Given
		process.env.PATH = writeCandidate("rg", 0o755);
		// When
		const resolved = getToolPath("rg");
		// Then
		expect(resolved).toBe("rg");
	});

	test("#given a readable but non-executable file #when the tool is resolved #then it is not accepted", () => {
		// Given
		process.env.PATH = writeCandidate("rg", 0o644);
		// When
		const resolved = getToolPath("rg");
		// Then
		expect(resolved).toBeNull();
	});

	test("#given an empty PATH #when the tool is resolved #then nothing is found and nothing throws", () => {
		// Given
		process.env.PATH = "";
		// When
		const resolved = getToolPath("rg");
		// Then
		expect(resolved).toBeNull();
	});

	test("#given a directory named like the tool #when the tool is resolved #then the directory is skipped", () => {
		// Given
		const binDir = join(pathRoot, "bin");
		mkdirSync(join(binDir, "rg"), { recursive: true });
		process.env.PATH = binDir;
		// When
		const resolved = getToolPath("rg");
		// Then
		expect(resolved).toBeNull();
	});
});
