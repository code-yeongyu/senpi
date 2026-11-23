import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cleanupTempDirs, settleBeforeRemoval, trackTempDir } from "../../../../scripts/vitest-temp.ts";
import { createFallbackLogger } from "../../src/core/retry-fallback/log.ts";
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

	it("waits for a fallback logger another session started under the directory before removing it", async () => {
		const harness = await createHarness();
		// The shape of retry-fallback-circuit-lifecycle and 3333-startup-pick-startable-model: a second session's agent dir
		// inside the harness directory, whose fallback log is still doing its first-start work.
		let loggerSettled = false;
		void createFallbackLogger(join(harness.tempDir, "other-agent"))
			.settled()
			.then(() => {
				loggerSettled = true;
			});
		harness.cleanup();
		await cleanupTempDirs();
		// The removal is awaited behind every fallback logger's settle, so it cannot finish first.
		expect(loggerSettled).toBe(true);
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

	it("waits for several harnesses at once and reports every writer that did not finish", async () => {
		const [first, second] = [held(), held()];
		const asked: number[] = [];
		const directories = [first, second].map((writer, index) => {
			const directory = mkdtempSync(join(tmpdir(), "pi-suite-teardown-"));
			trackTempDir(directory);
			settleBeforeRemoval(
				directory,
				() => {
					asked.push(index + 1);
					return writer.closed;
				},
				() => `tool child pid ${index + 1}`,
				200,
			);
			return directory;
		});
		const teardown = cleanupTempDirs();
		const rejected = expect(teardown).rejects.toThrow(
			/tool child pid 1 did not finish[\s\S]*tool child pid 2 did not finish/,
		);
		// Both writers are asked before either deadline: waiting one after the other would ask the second only after
		// the first had used up its whole deadline.
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(asked).toEqual([1, 2]);
		await rejected;
		for (const directory of directories) expect(existsSync(directory)).toBe(true);

		first.release();
		second.release();
		for (const directory of directories) trackTempDir(directory);
		await cleanupTempDirs();
		for (const directory of directories) expect(existsSync(directory)).toBe(false);
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
