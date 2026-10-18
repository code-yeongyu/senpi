import { vi } from "vitest";

const fsState = vi.hoisted(() => ({
	deniedPath: undefined as string | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const realpathSync = Object.assign(
		(path: Parameters<typeof actual.realpathSync>[0]) => {
			if (fsState.deniedPath !== undefined && String(path) === fsState.deniedPath) {
				throw Object.assign(new Error(`EACCES: permission denied, realpath '${String(path)}'`), { code: "EACCES" });
			}
			return actual.realpathSync(path);
		},
		{ native: actual.realpathSync.native },
	);
	return { ...actual, realpathSync, default: { ...actual, realpathSync } };
});

import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinParserRegistry } from "../../src/core/extensions/builtin/permission-system/parsers.ts";
import { getApprovedMonitorParent } from "../../src/core/extensions/builtin/terminal/monitor-permission.ts";

const isWindows = process.platform === "win32";
const isRoot = process.getuid?.() === 0;

let root = "";

afterEach(() => {
	fsState.deniedPath = undefined;
	if (root) {
		rmSync(root, { recursive: true, force: true });
		root = "";
	}
});

function createRoot(): string {
	root = mkdtempSync(join(realpathSync(tmpdir()), "monitor-parser-parent-"));
	return root;
}

function parseMonitor(input: Record<string, unknown>, cwd: string) {
	return createBuiltinParserRegistry().parse("monitor", input, cwd);
}

describe("monitor permission parser: approved parent", () => {
	it("derives the approved parent without realpath when the parent directory cannot be opened", () => {
		// given
		const cwd = createRoot();
		const parent = join(cwd, "logs");
		mkdirSync(parent);
		fsState.deniedPath = parent;
		const target = join(parent, "out.log");
		const input: Record<string, unknown> = { description: "probe", path: target };

		// when
		const requests = parseMonitor(input, cwd);

		// then
		expect(getApprovedMonitorParent(input)).toBe(parent);
		expect(requests[0]).toEqual({ permission: "read", patterns: [target], always: [target] });
	});

	it("resolves a relative monitor path against the cwd", () => {
		// given
		const cwd = createRoot();
		mkdirSync(join(cwd, "logs"));
		const input: Record<string, unknown> = { description: "probe", path: join("logs", "out.log") };

		// when
		parseMonitor(input, cwd);

		// then
		expect(getApprovedMonitorParent(input)).toBe(join(cwd, "logs"));
	});

	it.skipIf(isWindows)("resolves a symlinked parent to the directory it points at", () => {
		// given
		const cwd = createRoot();
		const real = join(cwd, "real");
		const link = join(cwd, "link");
		mkdirSync(real);
		symlinkSync(real, link, "dir");
		const input: Record<string, unknown> = { description: "probe", path: join(link, "out.log") };

		// when
		parseMonitor(input, cwd);

		// then
		expect(getApprovedMonitorParent(input)).toBe(real);
	});

	// Bun's fs.realpath* opens every directory it walks; an execute-only parent fails with EACCES there.
	it.skipIf(isWindows || isRoot)("derives the approved parent through an execute-only directory", () => {
		// given
		const cwd = createRoot();
		const executeOnly = join(cwd, "noread");
		const parent = join(executeOnly, "logs");
		mkdirSync(parent, { recursive: true });
		chmodSync(executeOnly, 0o111);
		const input: Record<string, unknown> = { description: "probe", path: join(parent, "out.log") };
		try {
			// when
			parseMonitor(input, cwd);

			// then
			expect(getApprovedMonitorParent(input)).toBe(parent);
		} finally {
			chmodSync(executeOnly, 0o755);
		}
	});
});
