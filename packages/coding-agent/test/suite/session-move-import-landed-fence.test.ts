/**
 * senpi#6413, from the review of its fix: an import that finds this move's session file at its target answers that
 * file only when the move's record agrees. Here the file appears at the target while the record is closed or names
 * another folder, at each point an import looks for it (before it starts receiving, and before its commit), and the
 * import must still be refused `move_fenced` with the record left as it was. An import that answers the landed
 * session after its own commit was fenced removes the staging folder it filled.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { type MoveAnswer, MoveLedger, READY_TTL_MS } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { MOVE, setup } from "./session-move-fixture.ts";

type World = Awaited<ReturnType<typeof setup>>;

const cannotBeRemoved = vi.hoisted(() => new Set<string>());

// A folder a test names here cannot be removed, nor anything in it: what an import does when its cleanup fails.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (...args: Parameters<typeof actual.rm>) => {
			const path = String(args[0]);
			if ([...cannotBeRemoved].some((folder) => path === folder || path.startsWith(`${folder}${sep}`)))
				throw Object.assign(new Error("EBUSY: busy"), { code: "EBUSY" });
			return actual.rm(...args);
		},
	};
});

afterEach(() => {
	cannotBeRemoved.clear();
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const importInto = (world: World, ledger: MoveLedger, sessionDir: string) =>
	importMovedSession({
		bundleDir: world.bundleDir,
		targetCwd: world.cwdB,
		ledger,
		readIdentity: world.readIdentity,
		sessionDir,
	});

const defaultFolder = (world: World) => getDefaultSessionDir(world.cwdB);
const landingOf = (world: World) => join(defaultFolder(world), basename(world.source));

const refusal = (pending: Promise<unknown>) =>
	pending.then(
		() => "answered",
		(error: unknown) =>
			typeof error === "object" && error !== null && "code" in error ? String(error.code) : "threw",
	);

/** This move's session file as an import lands it, made through a ledger of its own in a folder of its own. */
async function landedCopy(world: World): Promise<string> {
	const other = new MoveLedger(join(world.base, "ledger-copy"));
	await other.prepare(MOVE);
	return (await importInto(world, other, join(world.base, "copy"))).sessionFile;
}

function place(file: string, target: string): void {
	mkdirSync(dirname(target), { recursive: true });
	copyFileSync(file, target);
}

/** Puts this move's landed file at the target right before it asks to start receiving. */
class PlacesBeforeReceive extends MoveLedger {
	private readonly file: string;

	constructor(dir: string, file: string, options: { readonly now?: () => number } = {}) {
		super(dir, options);
		this.file = file;
	}

	override beginReceive(moveId: MoveId, target: string): Promise<void> {
		place(this.file, target);
		return super.beginReceive(moveId, target);
	}
}

/**
 * Right before its commit, an overlapping import's failure is recorded and this move's landed file appears at the
 * target. Once receiving began the record names this target, so a failed record is what can close it here.
 */
class FailedBeforeCommit extends MoveLedger {
	private readonly file: () => Promise<string>;

	constructor(dir: string, file: () => Promise<string>) {
		super(dir);
		this.file = file;
	}

	override async commit<T>(
		moveId: MoveId,
		target: string,
		rename: (stampStands: () => Promise<void>) => T | Promise<T>,
		prepare?: () => void | Promise<void>,
	): Promise<T> {
		await this.fail(moveId, "import_failed");
		place(await this.file(), target);
		return super.commit(moveId, target, rename, prepare);
	}
}

/** Holds right after its receive started, so another import can land the move before this one stages. */
class HoldsAfterReceive extends MoveLedger {
	readonly receiving = deferred();
	readonly gate = deferred();

	override async beginReceive(moveId: MoveId, target: string): Promise<void> {
		await super.beginReceive(moveId, target);
		this.receiving.resolve();
		await this.gate.promise;
	}
}

describe("this move's file at the target while the record does not agree (senpi#6413)", () => {
	it.each<[string, (world: World) => Promise<MoveLedger>, MoveAnswer]>([
		[
			"the receiver cancelled the move",
			async (world) => {
				await world.ledger.decline(MOVE, "cancelled");
				return new PlacesBeforeReceive(world.ledger.dir, await landedCopy(world));
			},
			{ state: "declined", reason: "cancelled" },
		],
		[
			"an earlier import failed",
			async (world) => {
				await world.ledger.fail(MOVE, "bundle_invalid");
				return new PlacesBeforeReceive(world.ledger.dir, await landedCopy(world));
			},
			{ state: "failed", reason: "bundle_invalid" },
		],
		[
			"the ready window passed",
			async (world) =>
				new PlacesBeforeReceive(world.ledger.dir, await landedCopy(world), {
					now: () => Date.now() + READY_TTL_MS + 1,
				}),
			{ state: "declined", reason: "expired" },
		],
		[
			"the move landed in another folder",
			async (world) =>
				new PlacesBeforeReceive(
					world.ledger.dir,
					(await importInto(world, world.ledger, join(world.base, "elsewhere"))).sessionFile,
				),
			{ state: "accepted" },
		],
	])(
		"#given %s #when the file appears before the import starts receiving #then it is refused move_fenced and the record stays",
		async (_case, arrange, record) => {
			const world = await setup();
			const ledger = await arrange(world);

			expect(await refusal(importInto(world, ledger, defaultFolder(world)))).toBe("move_fenced");
			expect(await ledger.answerStatus(MOVE, { movedIn: false })).toEqual(record);
		},
	);

	it("#given an overlapping import failed #when the file appears before the import's commit #then it is refused move_fenced and the record stays", async () => {
		const world = await setup();
		const ledger = new FailedBeforeCommit(world.ledger.dir, () => landedCopy(world));

		expect(await refusal(importInto(world, ledger, defaultFolder(world)))).toBe("move_fenced");
		expect(await world.ledger.answerStatus(MOVE, { movedIn: false })).toEqual({
			state: "failed",
			reason: "import_failed",
		});
	});
});

/** From its commit on, the staging folder this import filled cannot be removed. */
class CannotRemoveStagingAfterItsCommit extends HoldsAfterReceive {
	override commit<T>(
		moveId: MoveId,
		target: string,
		rename: (stampStands: () => Promise<void>) => T | Promise<T>,
		prepare?: () => void | Promise<void>,
	): Promise<T> {
		cannotBeRemoved.add(join(dirname(target), ".move-staging", encodeURIComponent(moveId)));
		return super.commit(moveId, target, rename, prepare);
	}
}

describe("an import whose commit was fenced by another import's landing (senpi#6413)", () => {
	it("#given it staged after the landing import removed the staging folder #when it answers the landed session #then no staging folder is left", async () => {
		const world = await setup();
		const late = new HoldsAfterReceive(world.ledger.dir);
		const importLate = importInto(world, late, defaultFolder(world));
		await late.receiving.promise;
		const landed = await importInto(world, world.ledger, defaultFolder(world));
		const staging = join(defaultFolder(world), ".move-staging", encodeURIComponent(MOVE));
		expect(existsSync(staging)).toBe(false);

		late.gate.resolve();

		expect(await importLate).toEqual({ sessionFile: landed.sessionFile });
		expect(landed.sessionFile).toBe(landingOf(world));
		expect(existsSync(staging)).toBe(false);
	});

	it("#given its staging folder cannot be removed #when it answers the landed session #then the answer is still the landed session", async () => {
		const world = await setup();
		const late = new CannotRemoveStagingAfterItsCommit(world.ledger.dir);
		const importLate = importInto(world, late, defaultFolder(world));
		await late.receiving.promise;
		const landed = await importInto(world, world.ledger, defaultFolder(world));

		late.gate.resolve();

		expect(await importLate).toEqual({ sessionFile: landed.sessionFile });
		expect(await world.ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "accepted" });
		// What it staged is still there: the removal did fail, and the answer did not depend on it.
		expect(existsSync(join(defaultFolder(world), ".move-staging", encodeURIComponent(MOVE)))).toBe(true);
	});
});
