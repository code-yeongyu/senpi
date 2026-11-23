import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, settleBeforeRemoval, trackTempDir } from "../../../../scripts/vitest-temp.ts";
import { createHarness, type Harness } from "./harness.ts";

// senpi#3570: a harness's temp directory is removed only after its session's tool child has exited. Removing it
// while the child still wrote into it failed unrelated tests with ENOTEMPTY under load.

function held() {
	let release: () => void = () => undefined;
	const closed = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { closed, release };
}

describe("harness teardown (senpi#3570)", () => {
	it("keeps the directory while the session's tool child is still closing and removes it once that settles", async () => {
		const harness = await createHarness();
		const child = held();
		harness.session.whenToolChildClosed = () => child.closed;
		writeFileSync(join(harness.tempDir, "late-write.log"), "still writing\n");

		harness.cleanup();
		expect(existsSync(harness.tempDir)).toBe(true);
		const teardown = cleanupTempDirs();
		expect(existsSync(harness.tempDir)).toBe(true);

		child.release();
		await teardown;
		expect(existsSync(harness.tempDir)).toBe(false);
	});

	it("fails naming the writer and leaves the directory when the writer does not finish in time", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-suite-teardown-"));
		trackTempDir(directory);
		const writer = held();
		settleBeforeRemoval(
			directory,
			() => writer.closed,
			() => "tool child pid 4242",
			50,
		);

		await expect(cleanupTempDirs()).rejects.toThrow(/tool child pid 4242 did not finish within 50 ms/);
		expect(existsSync(directory)).toBe(true);

		writer.release();
		trackTempDir(directory);
		await cleanupTempDirs();
		expect(existsSync(directory)).toBe(false);
	});

	describe("from a beforeAll, outside any test's own hooks", () => {
		let early: Harness;
		beforeAll(async () => {
			early = await createHarness();
		});

		it("still waits for that harness's tool child before removing its directory", async () => {
			const child = held();
			early.session.whenToolChildClosed = () => child.closed;
			early.cleanup();
			const teardown = cleanupTempDirs();
			expect(existsSync(early.tempDir)).toBe(true);
			child.release();
			await teardown;
			expect(existsSync(early.tempDir)).toBe(false);
		});
	});
});
