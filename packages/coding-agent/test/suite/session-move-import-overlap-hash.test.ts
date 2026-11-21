/**
 * Two imports of one request into one session folder overlap when a caller sends the import again while the first still
 * runs. Both begin receiving, and staging takes no lock. Where both stage in one folder for the move, the second one
 * replaces what the first staged and appends its moved-in entry there, and the first then hashes bytes that are no longer
 * the ones it copied: a good request is refused as an invalid bundle and recorded failed. Each import attempt staging in
 * a folder of its own (senpi#6445) is what this row holds; the review of senpi#6579 found it (senpi#6578).
 */
import { basename, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { MOVE, setup } from "./session-move-fixture.ts";

const disk = vi.hoisted(() => ({ afterCopy: undefined as ((to: string) => Promise<void>) | undefined }));

// A copy is on disk once it returns: the row holds an import right after one, where a slow disk would hold it.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
			await actual.copyFile(...args);
			await disk.afterCopy?.(String(args[1]));
		},
	};
});

afterEach(() => {
	disk.afterCopy = undefined;
});

/** The first import to reach its commit waits there until `gate` opens; any later one goes on. */
class FirstWaitsAtCommit extends MoveLedger {
	readonly reached = Promise.withResolvers<void>();
	readonly gate = Promise.withResolvers<void>();
	#commits = 0;

	override async commit<T>(
		moveId: MoveId,
		target: string,
		rename: () => T | Promise<T>,
		prepare?: () => void | Promise<void>,
	): Promise<T> {
		if (this.#commits++ === 0) {
			this.reached.resolve();
			await this.gate.promise;
		}
		return super.commit(moveId, target, rename, prepare);
	}
}

const settled = (pending: Promise<{ readonly sessionFile: string }>) =>
	pending.then(
		(value) => ({ value }),
		(error: unknown) => ({
			refused: typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error),
		}),
	);

describe("two overlapping imports of one request (senpi#6578)", () => {
	it("#given two imports of one request into one folder, the first held right after it staged a sidecar #when the second stages, writes its moved-in entry and waits at its commit, and the first then goes on #then neither is refused: both answer the landed session, and the move is recorded accepted, never failed", async () => {
		const world = await setup();
		const ledger = new FirstWaitsAtCommit(world.ledger.dir);
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let sidecars = 0;
		disk.afterCopy = async (to) => {
			if (!to.includes(`${sep}extensions${sep}`) || ++sidecars !== 1) return;
			held.resolve();
			await release.promise;
		};
		const importOnce = () =>
			importMovedSession({
				bundleDir: world.bundleDir,
				targetCwd: world.cwdB,
				ledger,
				readIdentity: world.readIdentity,
			});

		const first = settled(importOnce());
		await held.promise;
		const second = settled(importOnce());
		await ledger.reached.promise;
		release.resolve();
		const firstAnswer = await first;
		ledger.gate.resolve();
		const secondAnswer = await second;

		const landing = join(getDefaultSessionDir(world.cwdB), basename(world.source));
		const status = await ledger.answerStatus(MOVE, { movedIn: false });
		expect({ first: firstAnswer, second: secondAnswer, status }).toEqual({
			first: { value: { sessionFile: landing } },
			second: { value: { sessionFile: landing } },
			status: { state: "accepted" },
		});
	});
});
