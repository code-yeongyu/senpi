/**
 * senpi#4016: an import assembles the session it is about to land in a staging folder, outside the move's record lock.
 * Imports of one move overlap when a caller sends the import again while the first still runs. With one staging folder
 * per move, the second import replaced what the first was still writing, and whichever ended first removed the folder
 * under the other. Each import attempt stages in a folder of its own, and removes only that folder.
 */
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir, SessionManager } from "../../src/core/session-manager.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import { type MoveId, SESSION_MOVED_IN } from "../../src/core/session-move/ownership.ts";
import { admittedInputs, customTypes, MOVE, SESSION_ID, setup } from "./session-move-fixture.ts";

type World = Awaited<ReturnType<typeof setup>>;

const disk = vi.hoisted(() => ({
	afterCopy: undefined as ((to: string) => Promise<void>) | undefined,
	beforeMkdtemp: undefined as ((prefix: string) => void) | undefined,
}));

// A copy is on disk once it returns: a test holds an import right after one, where a slow disk would hold it. A test
// also acts right before an import makes its own folder, where another import's cleanup can run.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
			await actual.copyFile(...args);
			await disk.afterCopy?.(String(args[1]));
		},
		mkdtemp: async (...args: Parameters<typeof actual.mkdtemp>) => {
			disk.beforeMkdtemp?.(String(args[0]));
			return actual.mkdtemp(...args);
		},
	};
});

afterEach(() => {
	disk.afterCopy = undefined;
	disk.beforeMkdtemp = undefined;
});

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/** Waits at the door of its commit: it staged, the record is receiving, nothing is stamped and the lock is free. */
class WaitsBeforeCommit extends MoveLedger {
	readonly reached = deferred();
	readonly gate = deferred();

	override async commit<T>(
		moveId: MoveId,
		target: string,
		rename: () => T | Promise<T>,
		prepare?: () => void,
	): Promise<T> {
		this.reached.resolve();
		await this.gate.promise;
		return super.commit(moveId, target, rename, prepare);
	}
}

const stagingOf = (world: World) => join(getDefaultSessionDir(world.cwdB), ".move-staging");
const landingOf = (world: World) => join(getDefaultSessionDir(world.cwdB), basename(world.source));

const importWith = (world: World, ledger: MoveLedger) =>
	importMovedSession({ bundleDir: world.bundleDir, targetCwd: world.cwdB, ledger, readIdentity: world.readIdentity });

const settled = (pending: Promise<{ readonly sessionFile: string }>) =>
	pending.then(
		(value) => ({ value }),
		(error: unknown) => ({
			refused: typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error),
		}),
	);

/**
 * Holds the first import that copies the session file into staging, right after that copy: its session file is staged,
 * its sidecars and its moved-in entry are not. `staged()` is the copy it made.
 */
function holdFirstStagedSessionCopy(world: World) {
	const reached = deferred();
	const gate = deferred();
	let copy = "";
	disk.afterCopy = async (to) => {
		if (basename(to) !== basename(world.source) || !to.startsWith(`${stagingOf(world)}${sep}`)) return;
		disk.afterCopy = undefined;
		copy = to;
		reached.resolve();
		await gate.promise;
	};
	return { reached: reached.promise, resume: gate.resolve, staged: () => copy };
}

const userMessages = (file: string): unknown[] =>
	readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as { type: string; message?: { role?: string; content?: unknown } })
		.filter((entry) => entry.type === "message" && entry.message?.role === "user")
		.map((entry) => entry.message?.content);

/** What the session folder holds of the move once every import of it ended. */
function landedIn(world: World) {
	const sessionDir = getDefaultSessionDir(world.cwdB);
	const file = landingOf(world);
	return {
		sessionFiles: readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")),
		transcript: userMessages(file),
		queuedInput: admittedInputs(file),
		movedIn: customTypes(file).filter((type) => type === SESSION_MOVED_IN),
		sidecar: existsSync(join(sessionDir, "extensions", "goal", `${SESSION_ID}.json`)),
		staging: readdirSync(stagingOf(world)),
	};
}

const oneWholeSession = (world: World) => ({
	sessionFiles: [basename(world.source)],
	transcript: ["remember 42"],
	queuedInput: ["queued follow-up"],
	movedIn: [SESSION_MOVED_IN],
	sidecar: true,
	staging: [],
});

describe("two imports of one move staging in one session folder (senpi#4016)", () => {
	it("#given two imports of one move, the first held after it copied the session file and before it appends its moved-in entry #when the second stages and the first resumes #then exactly one session file lands, it holds the bundle's whole transcript, the queued input and one moved-in entry, and the other import answers that file", async () => {
		const world = await setup();
		const copied = holdFirstStagedSessionCopy(world);
		const first = settled(importWith(world, world.ledger));
		await copied.reached;
		const second = new WaitsBeforeCommit(world.ledger.dir);
		const importSecond = settled(importWith(world, second));
		await second.reached.promise;

		copied.resume();
		const firstAnswer = await first;
		second.gate.resolve();
		const secondAnswer = await importSecond;

		expect(firstAnswer).toEqual({ value: { sessionFile: landingOf(world) } });
		expect(secondAnswer).toEqual({ value: { sessionFile: landingOf(world) } });
		expect(landedIn(world)).toEqual(oneWholeSession(world));
		expect(await world.ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "accepted" });
	});

	it("#given an import held after it copied the session file into staging #when another import of the move stages, lands and cleans up #then the held import's copy is still on disk, and once resumed it answers the landed session and removes only what it staged", async () => {
		const world = await setup();
		const copied = holdFirstStagedSessionCopy(world);
		const held = settled(importWith(world, world.ledger));
		await copied.reached;

		const landed = await settled(importWith(world, new MoveLedger(world.ledger.dir)));
		const heldCopyKept = existsSync(copied.staged());
		copied.resume();
		const heldAnswer = await held;

		expect(landed).toEqual({ value: { sessionFile: landingOf(world) } });
		expect(heldCopyKept).toBe(true);
		expect(heldAnswer).toEqual({ value: { sessionFile: landingOf(world) } });
		expect(landedIn(world)).toEqual(oneWholeSession(world));
	});

	it("#given the move's emptied staging folder is removed, as an import that just ended removes it, right before another import makes its own folder there #when that import stages #then it makes the folder again and lands the session", async () => {
		const world = await setup();
		let removed = 0;
		disk.beforeMkdtemp = (prefix) => {
			if (!prefix.startsWith(`${stagingOf(world)}${sep}`) || removed > 0) return;
			rmdirSync(dirname(prefix));
			removed += 1;
		};

		const answer = await settled(importWith(world, world.ledger));

		expect(removed).toBe(1);
		expect(answer).toEqual({ value: { sessionFile: landingOf(world) } });
		expect(landedIn(world)).toEqual(oneWholeSession(world));
	});
});

describe("staging that imports which died left in a session folder (senpi#4016)", () => {
	it("#given one move's staging not modified for over an hour and another move's younger staging #when a move is imported into that folder #then the old staging is removed with its emptied folder and the young one is kept", async () => {
		const world = await setup();
		const old = join(stagingOf(world), "move-dead-old");
		const young = join(stagingOf(world), "move-dead-young", "attempt-left");
		// An attempt's folder, and a session file an older version staged directly in the move's folder.
		const leftovers = [join(old, "attempt-left"), young];
		for (const dir of leftovers) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "session.jsonl"), "{}\n");
		}
		writeFileSync(join(old, "session.jsonl"), "{}\n");
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60_000);
		for (const entry of [join(old, "attempt-left"), join(old, "session.jsonl")])
			utimesSync(entry, twoHoursAgo, twoHoursAgo);

		const answer = await settled(importWith(world, world.ledger));

		expect(answer).toEqual({ value: { sessionFile: landingOf(world) } });
		expect(readdirSync(stagingOf(world))).toEqual(["move-dead-young"]);
		expect(readdirSync(young)).toEqual(["session.jsonl"]);
	});

	it("#given the staging an import of this move left when it died after it staged the session #when the move is imported again #then it stages again from the bundle: the session lands with one moved-in entry and the input queued once, and what the dead import left is not touched", async () => {
		const world = await setup();
		const left = join(stagingOf(world), encodeURIComponent(MOVE), "left-by-a-dead-import", basename(world.source));
		mkdirSync(dirname(left), { recursive: true });
		cpSync(join(world.bundleDir, "files", "session.jsonl"), left);
		SessionManager.open(left, dirname(left)).appendCustomEntry(SESSION_MOVED_IN, {
			move_id: MOVE,
			session_id: SESSION_ID,
		});
		const leftBytes = readFileSync(left, "utf8");

		const answer = await settled(importWith(world, world.ledger));

		expect(answer).toEqual({ value: { sessionFile: landingOf(world) } });
		expect(customTypes(landingOf(world)).filter((type) => type === SESSION_MOVED_IN)).toEqual([SESSION_MOVED_IN]);
		expect(admittedInputs(landingOf(world))).toEqual(["queued follow-up"]);
		expect(existsSync(left) ? readFileSync(left, "utf8") : "removed").toBe(leftBytes);
	});

	// senpi#6445's review: the sweep threw what listing another move's folder threw, and the import failed with it.
	// A root process lists any folder, so the case cannot be made there (as in rpc-host-gc-removal.test.ts).
	it.skipIf(process.getuid?.() === 0)(
		"#given another move's staging folder in that session folder that cannot be listed #when a move is imported there #then the session lands and is answered as if nothing had been left, and that folder is not touched",
		async () => {
			const world = await setup();
			const unreadable = join(stagingOf(world), "move-of-another");
			mkdirSync(join(unreadable, "attempt-left"), { recursive: true });
			chmodSync(unreadable, 0o000);
			const listing = await readdir(unreadable).then(
				() => "listed",
				(error: unknown) => (error instanceof Error && "code" in error ? error.code : error),
			);

			const answer = await settled(importWith(world, world.ledger));
			chmodSync(unreadable, 0o700);

			expect(listing).toBe("EACCES");
			expect(answer).toEqual({ value: { sessionFile: landingOf(world) } });
			expect(await world.ledger.answerStatus(MOVE, { movedIn: false })).toEqual({ state: "accepted" });
			expect(readdirSync(stagingOf(world))).toEqual(["move-of-another"]);
			expect(readdirSync(unreadable)).toEqual(["attempt-left"]);
		},
	);
});
