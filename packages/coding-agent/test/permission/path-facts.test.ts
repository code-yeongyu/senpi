import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	decideWithPathFacts,
	FACT_PENDING,
	PATH_FACT_DEADLINE_MS,
	PathFacts,
} from "../../src/core/extensions/builtin/permission-system/path-facts.ts";

// senpi#4565: a permission decision runs synchronously on the host thread and reads its filesystem answers from
// PathFacts; the facts are fetched off the thread, each bounded by a deadline.
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(): string {
	const root = mkdtempSync(join(tmpdir(), "senpi-path-facts-"));
	roots.push(root);
	mkdirSync(join(root, "real"));
	writeFileSync(join(root, "real", "file.txt"), "x");
	symlinkSync(join(root, "real"), join(root, "link"));
	return root;
}

const codeOf = (run: () => unknown): string | undefined => {
	try {
		run();
		return undefined;
	} catch (error) {
		return (error as { code?: string }).code;
	}
};

describe("PathFacts", () => {
	it("throws a pending code for a fact not fetched yet, then answers from the fetched one", async () => {
		// Given facts with nothing fetched
		const root = tree();
		const facts = new PathFacts();

		// When a reader asks, then the missing facts are fetched
		expect(codeOf(() => facts.readlink(join(root, "link")))).toBe(FACT_PENDING);
		expect(facts.incomplete).toBe(true);
		await facts.fetchMissing();

		// Then the reader gets the filesystem's answer, and a missing name its error code
		expect(facts.readlink(join(root, "link"))).toBe(join(root, "real"));
		expect(codeOf(() => facts.lstat(join(root, "nope")))).toBe(FACT_PENDING);
		await facts.fetchMissing();
		expect(codeOf(() => facts.lstat(join(root, "nope")))).toBe("ENOENT");
		expect(facts.lstatIfPresent(join(root, "nope"))).toBeUndefined();
	});

	it("records a fact whose fetch never settles as timed out at its deadline, on the virtual clock", async () => {
		// Given facts whose filesystem never answers (a mount that hangs), on fake timers
		vi.useFakeTimers();
		try {
			const facts = new PathFacts(() => new Promise(() => {}));
			codeOf(() => facts.lstat("/mnt/hung/x"));

			// When the fetch runs past the deadline
			const fetched = facts.fetchMissing();
			await vi.advanceTimersByTimeAsync(PATH_FACT_DEADLINE_MS);
			await fetched;

			// Then the reader gets a typed timeout, never a hang
			expect(codeOf(() => facts.lstat("/mnt/hung/x"))).toBe("ETIMEDOUT");
		} finally {
			vi.useRealTimers();
		}
	});

	it("converges a decision that walks a link one fact at a time", async () => {
		// Given a decision that needs lstat of the link, then its target, then a stat of the file under it
		const root = tree();
		let runs = 0;

		// When it is decided through the driver
		const answer = await decideWithPathFacts((facts) => {
			runs += 1;
			try {
				if (!facts.lstat(join(root, "link")).isSymbolicLink()) return "plain";
				const target = facts.readlink(join(root, "link"));
				return facts.stat(join(target, "file.txt")).isFile() ? "file through link" : "other";
			} catch (error) {
				return `error ${(error as { code?: string }).code}`;
			}
		});

		// Then it reaches the full answer after one fetch round per newly revealed fact
		expect(answer).toBe("file through link");
		expect(runs).toBe(4);
	});
});
