import { vi } from "vitest";

const fsState = vi.hoisted(() => ({
	hangRealpath: false,
	realpathCalls: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: async (...args: Parameters<typeof actual.realpath>) => {
			fsState.realpathCalls += 1;
			if (fsState.hangRealpath) return await new Promise<never>(() => {});
			return actual.realpath(...args);
		},
	};
});

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalizeFilesystemPath } from "../src/core/tools/filesystem-policy.ts";

const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;

let root = "";

afterEach(() => {
	fsState.hangRealpath = false;
	fsState.realpathCalls = 0;
	if (root) {
		rmSync(root, { recursive: true, force: true });
		root = "";
	}
});

function createRoot(): string {
	root = mkdtempSync(join(realpathSync(tmpdir()), "fs-policy-canonicalize-"));
	return root;
}

describe("canonicalizeFilesystemPath", () => {
	it("resolves an existing file through a symlinked parent", async () => {
		// given
		const dir = createRoot();
		const real = join(dir, "real");
		const link = join(dir, "link");
		mkdirSync(real);
		writeFileSync(join(real, "file.txt"), "hello");
		if (!isWindows) symlinkSync(real, link, "dir");

		// when
		const resolved = await canonicalizeFilesystemPath(join(isWindows ? real : link, "file.txt"));

		// then
		expect(resolved).toBe(join(real, "file.txt"));
	});

	it("appends missing descendants to the nearest existing real parent", async () => {
		// given
		const dir = createRoot();
		const real = join(dir, "real");
		mkdirSync(real);

		// when
		const resolved = await canonicalizeFilesystemPath(join(real, "missing", "new.txt"));

		// then
		expect(resolved).toBe(join(real, "missing", "new.txt"));
	});

	// Correctness first: realpath is what supplies the on-disk spelling and applies `..` the way the
	// following I/O will, so it must be attempted. Boundedness second: on a wedged mount (a macOS
	// autofs trigger) it never answers, and this runs before every read/ls/grep/find/edit/write, so
	// the caller still gets an answer from the open-free walker. The mock stands in for that mount.
	it("attempts realpath and still answers when it never returns", async () => {
		// given
		const dir = createRoot();
		mkdirSync(join(dir, "logs"));
		fsState.hangRealpath = true;

		// when
		const resolved = await canonicalizeFilesystemPath(join(dir, "logs", "out.log"));

		// then
		expect(resolved).toBe(join(dir, "logs", "out.log"));
		expect(fsState.realpathCalls).toBeGreaterThan(0);
	}, 20_000);

	it.skipIf(isWindows || isRoot)("resolves a target under an execute-only directory", async () => {
		// given
		const dir = createRoot();
		const executeOnly = join(dir, "noread");
		mkdirSync(join(executeOnly, "logs"), { recursive: true });
		chmodSync(executeOnly, 0o111);
		try {
			// when
			const resolved = await canonicalizeFilesystemPath(join(executeOnly, "logs", "out.log"));

			// then
			expect(resolved).toBe(join(executeOnly, "logs", "out.log"));
		} finally {
			chmodSync(executeOnly, 0o755);
		}
	});
});
