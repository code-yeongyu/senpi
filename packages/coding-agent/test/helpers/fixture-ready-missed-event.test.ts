import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// senpi#4629: the ready file WAS written (the fixture's own stamps prove it) while the directory
// watcher never reported it. With `watch` delivering nothing, the wait must still settle, so this
// file - and only this file - replaces it; the real watcher is covered in fixture-ready.test.ts.
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, watch: () => ({ close: () => {} }) };
});

const { waitForFixtureFile } = await import("./fixture-ready.ts");

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("waitForFixtureFile with no watch event delivered", () => {
	it("still settles on a file that was written, instead of hanging until its bound", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-fixture-missed-"));
		roots.push(root);
		const ready = join(root, "ready");
		const startedAt = Date.now();
		const waited = waitForFixtureFile(ready, { timeoutMs: 30_000, output: () => "" });
		writeFileSync(ready, "1");
		await expect(waited).resolves.toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	}, 20_000);

	it("still reports a file that was never written", async () => {
		const root = mkdtempSync(join(tmpdir(), "senpi-fixture-missed-"));
		roots.push(root);
		await expect(
			waitForFixtureFile(join(root, "ready"), { timeoutMs: 600, output: () => "nothing booted" }),
		).rejects.toThrow(/was not written within 600ms[\s\S]*nothing booted/);
	}, 20_000);
});
