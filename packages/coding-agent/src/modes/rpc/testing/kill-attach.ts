/**
 * KILL-ATTACH: kill the engine before and after the durable takeover record, then restart on the same medium (01-04)
 * or retry in the surviving process (05). IDs stay stable, no record is lost or duplicated, and a retried takeover is
 * applied exactly once (S37, plan §3.5). Placement: everywhere.
 */
import type {
	AdmissionLine,
	DurableStore,
	StoreConformanceAdapter,
	StoreWritePoint,
} from "@earendil-works/pi-agent-core/conformance";
import { ATTACH_TAKEOVER_RECORD, type AttachLedger, createAttachLedger } from "../attach-ledger.ts";

export interface KillAttachDeclaration {
	readonly id: string;
	/** `first`: the session's first takeover; `next`: a takeover from its holder to another client. */
	readonly op: "first" | "next";
	readonly at: "before" | "durable";
	readonly placement: "everywhere";
}

/** The durable medium under test and the admission line every writer on one store epoch shares. */
export interface KillAttachAdapter extends StoreConformanceAdapter {
	createAdmission(): AdmissionLine;
}

export interface KillAttachCase extends KillAttachDeclaration {
	run(adapter: KillAttachAdapter): Promise<void>;
}

const SESSION = "session-1";
const FIRST = "device-a";
const NEXT = "device-b";

class AttachKill extends Error {
	constructor(point: StoreWritePoint) {
		super(`kill at ${JSON.stringify(point)}`);
		this.name = "AttachKill";
	}
}

const killOnceAt = (at: "before" | "durable") => {
	let armed = true;
	return {
		onWritePoint: (point: StoreWritePoint): void => {
			if (!armed || point.op !== "commit" || point.at !== at) return;
			armed = false;
			throw new AttachKill(point);
		},
	};
};

function expectSame(actual: unknown, expected: unknown, what: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}

async function expectKilled(operation: Promise<unknown>, what: string): Promise<void> {
	try {
		await operation;
	} catch (error) {
		if (error instanceof AttachKill) return;
		throw error;
	}
	throw new Error(`${what}: expected the kill to surface, but it resolved`);
}

interface Engine {
	readonly store: DurableStore;
	readonly ledger: AttachLedger;
}

async function engine(adapter: KillAttachAdapter, medium: string, kill?: "before" | "durable"): Promise<Engine> {
	const store = await adapter.open(medium, kill === undefined ? {} : killOnceAt(kill));
	return { store, ledger: createAttachLedger({ store, epoch: 1, admission: adapter.createAdmission() }) };
}

async function claimed(adapter: KillAttachAdapter): Promise<string> {
	const medium = await adapter.createMedium();
	await (await adapter.open(medium)).claim(0, 1);
	return medium;
}

/** Each takeover record as `holder@generation`, in commit order. */
const takeovers = async ({ store }: Engine): Promise<string[]> =>
	(await store.scanRecords())
		.filter(({ kind }) => kind === ATTACH_TAKEOVER_RECORD)
		.map(({ data }) => `${String(Object(data).holder)}@${String(Object(data).generation)}`);

const holder = async ({ ledger }: Engine): Promise<string | undefined> => {
	const record = await ledger.holderOf(SESSION);
	return record === undefined ? undefined : `${record.holder}@${record.generation}`;
};

const killCase = (
	id: string,
	op: KillAttachDeclaration["op"],
	at: KillAttachDeclaration["at"],
	run: KillAttachCase["run"],
): KillAttachCase => ({ id, op, at, placement: "everywhere", run });

export const KILL_ATTACH_CASES: readonly KillAttachCase[] = [
	killCase("KILL-ATTACH-01", "first", "before", async (adapter) => {
		const medium = await claimed(adapter);
		await expectKilled((await engine(adapter, medium, "before")).ledger.takeOver(SESSION, FIRST), "takeover");
		const restarted = await engine(adapter, medium);
		expectSame(await takeovers(restarted), [], "nothing of the takeover is durable");
		expectSame(await holder(restarted), undefined, "the session has no holder");
		await restarted.ledger.takeOver(SESSION, FIRST);
		await restarted.ledger.takeOver(SESSION, FIRST);
		expectSame(await takeovers(restarted), [`${FIRST}@1`], "the retried takeover is recorded once");
	}),
	killCase("KILL-ATTACH-02", "first", "durable", async (adapter) => {
		const medium = await claimed(adapter);
		await expectKilled((await engine(adapter, medium, "durable")).ledger.takeOver(SESSION, FIRST), "takeover");
		const restarted = await engine(adapter, medium);
		const [record] = await restarted.store.scanRecords();
		expectSame(await holder(restarted), `${FIRST}@1`, "the restart recovers the holder");
		const retried = await restarted.ledger.takeOver(SESSION, FIRST);
		expectSame(await restarted.store.scanRecords(), [record], "a retried takeover writes nothing");
		expectSame(`${ATTACH_TAKEOVER_RECORD}:${retried.takeoverId}`, record?.id, "the takeover keeps its id");
	}),
	killCase("KILL-ATTACH-03", "next", "before", async (adapter) => {
		const medium = await claimed(adapter);
		await (await engine(adapter, medium)).ledger.takeOver(SESSION, FIRST);
		await expectKilled((await engine(adapter, medium, "before")).ledger.takeOver(SESSION, NEXT), "takeover");
		const restarted = await engine(adapter, medium);
		expectSame(await holder(restarted), `${FIRST}@1`, "the first holder still holds the session");
		await restarted.ledger.takeOver(SESSION, NEXT);
		await restarted.ledger.takeOver(SESSION, NEXT);
		expectSame(await takeovers(restarted), [`${FIRST}@1`, `${NEXT}@2`], "one takeover per holder");
	}),
	killCase("KILL-ATTACH-04", "next", "durable", async (adapter) => {
		const medium = await claimed(adapter);
		await (await engine(adapter, medium)).ledger.takeOver(SESSION, FIRST);
		await expectKilled((await engine(adapter, medium, "durable")).ledger.takeOver(SESSION, NEXT), "takeover");
		const restarted = await engine(adapter, medium);
		expectSame(await holder(restarted), `${NEXT}@2`, "the takeover survives the kill");
		await restarted.ledger.takeOver(SESSION, NEXT);
		expectSame(await takeovers(restarted), [`${FIRST}@1`, `${NEXT}@2`], "a retried takeover writes nothing");
	}),
	killCase("KILL-ATTACH-05", "first", "durable", async (adapter) => {
		const medium = await claimed(adapter);
		const survivor = await engine(adapter, medium, "durable");
		await expectKilled(survivor.ledger.takeOver(SESSION, FIRST), "takeover");
		await survivor.ledger.takeOver(SESSION, FIRST);
		expectSame(await takeovers(survivor), [`${FIRST}@1`], "the retry adopts the durable takeover");
		await survivor.ledger.takeOver(SESSION, NEXT);
		expectSame(await holder(await engine(adapter, medium)), `${NEXT}@2`, "the next takeover follows it");
	}),
];
