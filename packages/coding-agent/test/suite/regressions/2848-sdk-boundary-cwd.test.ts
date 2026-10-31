import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSdkBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";

const sdkQuery = vi.hoisted(() =>
	vi.fn(() => ({
		async *[Symbol.asyncIterator]() {},
		async interrupt() {},
		close() {},
	})),
);
const sdkRead = vi.hoisted(() => vi.fn(async () => []));

vi.mock("../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.lazy.ts", () => ({
	loadClaudeAgentSdk: async () => ({ query: sdkQuery, getSessionMessages: sdkRead }),
	loadedClaudeAgentSdk: () => ({ query: sdkQuery, getSessionMessages: sdkRead }),
}));

const roots: string[] = [];
beforeEach(() => {
	sdkQuery.mockClear();
	sdkRead.mockClear();
});
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("senpi#2848 raw SDK query cwd boundary", () => {
	it.each([undefined, "", "relative-project"])("rejects cwd %s before entering the SDK", (cwd) => {
		expect(() => getSdkBoundary().query({ prompt: "cwd fixture", options: { cwd } })).toThrow(/session cwd/);
		expect(sdkQuery).not.toHaveBeenCalled();
	});

	it("passes the explicit session directory into the real query adapter", () => {
		const cwd = mkdtempSync(join(tmpdir(), "sdk-query-cwd-"));
		roots.push(cwd);
		getSdkBoundary().query({ prompt: "cwd fixture", options: { cwd } });
		expect(sdkQuery).toHaveBeenCalledWith({ prompt: "cwd fixture", options: { cwd } });
		expect(cwd).not.toBe(process.cwd());
	});

	it.each([undefined, "", "relative-project"])("rejects transcript cwd %s before entering the SDK", async (dir) => {
		await expect(getSdkBoundary().getSessionMessages("cwd-fixture", { dir })).rejects.toThrow(/session cwd/);
		expect(sdkRead).not.toHaveBeenCalled();
	});

	it("scopes SDK transcript lookup to the originating session directory", async () => {
		const dir = mkdtempSync(join(tmpdir(), "sdk-transcript-cwd-"));
		roots.push(dir);
		await getSdkBoundary().getSessionMessages("cwd-fixture", { dir });
		expect(sdkRead).toHaveBeenCalledWith("cwd-fixture", { dir });
		expect(dir).not.toBe(process.cwd());
	});
});
