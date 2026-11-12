/**
 * senpi#6492: what a commit's `prepare` removes, creates and copies is written under the move record's lock. A holder
 * that was told its lock is gone must stop before its next write: whoever took the lock may have settled the move, and
 * a write made after that touches files the holder no longer has a claim on. One case per write: the lock is lost
 * right before it, so only the check in front of that write can stop it.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getDefaultSessionDir } from "../../src/core/session-manager.ts";
import { exportSessionForMove } from "../../src/core/session-move/export.ts";
import { movedStateDir } from "../../src/core/session-move/extension-state.ts";
import { importMovedSession } from "../../src/core/session-move/import.ts";
import { MoveLedger } from "../../src/core/session-move/move-ledger.ts";
import type { MoveId } from "../../src/core/session-move/ownership.ts";
import { encodedSessionId } from "../../src/core/session-sidecar-store.ts";
import { SESSION_ID, setup, writeSession } from "./session-move-fixture.ts";

const afterWrite = vi.hoisted(() => new Map<string, () => void>());

// A write is durable once it returns. A test tells the holder its lock is gone right after one, which is right before
// the holder's next write.
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		rm: async (...args: Parameters<typeof actual.rm>) => {
			await actual.rm(...args);
			afterWrite.get(String(args[0]))?.();
		},
		mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
			const made = await actual.mkdir(...args);
			afterWrite.get(String(args[0]))?.();
			return made;
		},
	};
});

const realLock = lockfile.lock;
const STATE_MOVE = "move-0044" as MoveId;

afterEach(() => {
	vi.restoreAllMocks();
	afterWrite.clear();
});

/** `taken()` stands for the holder's lock refresh finding this record's lock taken: the lock is gone and it is told. */
function holderOf(record: string): { readonly taken: () => void } {
	let taken = () => {};
	vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
		const release = await realLock(file, options);
		if (file === record)
			taken = () => {
				void release().catch(() => undefined);
				options?.onCompromised?.(Object.assign(new Error("the lock was taken"), { code: "ECOMPROMISED" }));
			};
		return release;
	});
	return { taken: () => taken() };
}

/**
 * A ledger over `dir` whose commits run `asPrepareBegins` as their `prepare` begins: nothing is removed, created, copied
 * or stamped yet. It wraps the ledger's own `commit`, so it takes whatever `rename` that `commit` takes.
 */
function tellingAsPrepareBegins(dir: string, asPrepareBegins: () => void): MoveLedger {
	const ledger = new MoveLedger(dir);
	const commit = ledger.commit.bind(ledger);
	ledger.commit = (moveId, target, rename, prepare) =>
		commit(moveId, target, rename, async () => {
			asPrepareBegins();
			await prepare?.();
		});
	return ledger;
}

const codeOf = (error: unknown) =>
	typeof error === "object" && error !== null && "code" in error ? String(error.code) : String(error);

function plant(file: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, "kept");
}

/**
 * A receiver that already holds a read-only copy of the session with an extension sidecar and resident blobs, and a
 * file where moved extension state goes; and a bundle of that session that carries extension state. Importing it runs
 * every write of the `prepare` step, in this order: sidecar, blobs, the copy, the state folder, the state's own folder,
 * the state file.
 */
async function receiverWithEverythingToReplace() {
	const world = await setup();
	const source = writeSession(join(world.base, "a2", "repo"));
	const outgoing = join(world.base, "state-out");
	plant(join(outgoing, "probe", "state.json"));
	const bundleDir = join(world.base, "bundle-state");
	await world.ledger.prepare(STATE_MOVE);
	await exportSessionForMove({
		sessionFile: source,
		moveId: STATE_MOVE,
		target: "device-b",
		droppedUserMessages: [],
		bundleDir,
		extensionStateDir: outgoing,
	});
	const sessionDir = getDefaultSessionDir(world.cwdB);
	const copy = join(sessionDir, basename(source));
	const state = movedStateDir(copy, STATE_MOVE);
	const at = {
		sidecar: join(sessionDir, "extensions", "probe", `${encodedSessionId(SESSION_ID)}.json`),
		blobs: join(sessionDir, "resident-blobs", SESSION_ID),
		copy,
		state,
		stateFolder: join(state, "probe"),
		stateFile: join(state, "probe", "state.json"),
		already: join(state, "already.json"),
	};
	plant(at.sidecar);
	plant(join(at.blobs, "blob"));
	plant(at.already);
	// The sender's sealed file is a read-only copy of this session: what an import replaces at its landing.
	copyFileSync(source, at.copy);
	return { world, bundleDir, at };
}

type Paths = Awaited<ReturnType<typeof receiverWithEverythingToReplace>>["at"];

/** The write the lock is lost right before, and the write that completes right before it (none for the first). */
const WRITES: readonly {
	readonly write: string;
	readonly lostAfter: ((at: Paths) => string) | undefined;
	readonly left: Readonly<Record<"sidecar" | "blobs" | "copy" | "already" | "stateFolder" | "stateFile", boolean>>;
}[] = [
	{
		write: "the removal of the copy's extension sidecar",
		lostAfter: undefined,
		left: { sidecar: true, blobs: true, copy: true, already: true, stateFolder: false, stateFile: false },
	},
	{
		write: "the removal of the copy's resident blobs",
		lostAfter: (at) => at.sidecar,
		left: { sidecar: false, blobs: true, copy: true, already: true, stateFolder: false, stateFile: false },
	},
	{
		write: "the removal of the copy itself",
		lostAfter: (at) => at.blobs,
		left: { sidecar: false, blobs: false, copy: true, already: true, stateFolder: false, stateFile: false },
	},
	{
		write: "the removal of the folder moved state goes into",
		lostAfter: (at) => at.copy,
		left: { sidecar: false, blobs: false, copy: false, already: true, stateFolder: false, stateFile: false },
	},
	{
		write: "the creation of the moved state's own folder",
		lostAfter: (at) => at.state,
		left: { sidecar: false, blobs: false, copy: false, already: false, stateFolder: false, stateFile: false },
	},
	{
		write: "the copy of the moved state file",
		lostAfter: (at) => at.stateFolder,
		left: { sidecar: false, blobs: false, copy: false, already: false, stateFolder: true, stateFile: false },
	},
];

describe("a commit whose holder lost the move record's lock during its prepare step (senpi#6492)", () => {
	it.each(WRITES)(
		"#given a receiver with a copy, its sidecar and blobs, and a bundle with extension state #when the holder is told its lock was taken right before $write #then that write and every later one are not made and its import fails",
		async ({ lostAfter, left }) => {
			const { world, bundleDir, at } = await receiverWithEverythingToReplace();
			const lock = holderOf(join(world.ledger.dir, `${STATE_MOVE}.json`));
			const holder = tellingAsPrepareBegins(world.ledger.dir, lostAfter === undefined ? lock.taken : () => {});
			if (lostAfter !== undefined) afterWrite.set(lostAfter(at), lock.taken);

			const answer = await importMovedSession({
				bundleDir,
				targetCwd: world.cwdB,
				ledger: holder,
				readIdentity: world.readIdentity,
			}).then(() => "landed", codeOf);

			expect({
				answer,
				sidecar: existsSync(at.sidecar),
				blobs: existsSync(at.blobs),
				copy: existsSync(at.copy),
				already: existsSync(at.already),
				stateFolder: existsSync(at.stateFolder),
				stateFile: existsSync(at.stateFile),
			}).toEqual({ answer: "ELOCKLOST", ...left });
		},
	);
});
