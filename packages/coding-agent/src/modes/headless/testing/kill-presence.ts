/**
 * KILL-PRESENCE: kill the engine before and after the durable pause record and the durable resume record, restart on
 * the same medium, and check that IDs are stable and the bookkeeping intact (no lost or duplicated record) and that a
 * resume is applied exactly once (senpi#5652, plan §3.5). Placement: everywhere.
 */
import type {
	AdmissionLine,
	DurableStore,
	StoreConformanceAdapter,
	StoreWritePoint,
} from "@earendil-works/pi-agent-core/conformance";
import { type HeadlessPresence, openHeadlessPresence } from "../presence.ts";
import { createPresenceLedger, PRESENCE_PAUSE_RECORD, PRESENCE_RESUME_RECORD } from "../presence-ledger.ts";

export interface KillPresenceDeclaration {
	readonly id: string;
	readonly op: "pause" | "resume";
	readonly at: "before" | "durable";
	readonly placement: "everywhere";
}

/** The durable medium under test and the admission line every writer on one store epoch shares. */
export interface KillPresenceAdapter extends StoreConformanceAdapter {
	createAdmission(): AdmissionLine;
}

export interface KillPresenceCase extends KillPresenceDeclaration {
	run(adapter: KillPresenceAdapter): Promise<void>;
}

const OWNER = "owner-machine";
const SESSION = "session-1";

class PresenceKill extends Error {
	constructor(point: StoreWritePoint) {
		super(`kill at ${JSON.stringify(point)}`);
		this.name = "PresenceKill";
	}
}

const killOnceAt = (at: "before" | "durable") => {
	let armed = true;
	return {
		onWritePoint: (point: StoreWritePoint): void => {
			if (!armed || point.op !== "commit" || point.at !== at) return;
			armed = false;
			throw new PresenceKill(point);
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
		if (error instanceof PresenceKill) return;
		throw error;
	}
	throw new Error(`${what}: expected the kill to surface, but it resolved`);
}

interface Engine {
	readonly store: DurableStore;
	readonly presence: HeadlessPresence;
}

async function engine(adapter: KillPresenceAdapter, medium: string, kill?: "before" | "durable"): Promise<Engine> {
	const store = await adapter.open(medium, kill === undefined ? {} : killOnceAt(kill));
	const ledger = createPresenceLedger({ store, epoch: 1, admission: adapter.createAdmission() });
	const presence = await openHeadlessPresence({ ledger, placement: OWNER });
	await presence.track(SESSION, []);
	return { store, presence };
}

async function claimed(adapter: KillPresenceAdapter): Promise<string> {
	const medium = await adapter.createMedium();
	await (await adapter.open(medium)).claim(0, 1);
	return medium;
}

const records = async ({ store }: Engine) => (await store.scanRecords()).map(({ id, kind }) => ({ id, kind }));

const pausedOnOwner = { paused: true, state: "offline" };
const shape = ({ presence }: Engine) => {
	const { paused, state } = presence.view(SESSION);
	return { paused, state };
};

const killCase = (
	id: string,
	op: KillPresenceDeclaration["op"],
	at: KillPresenceDeclaration["at"],
	run: KillPresenceCase["run"],
): KillPresenceCase => ({ id, op, at, placement: "everywhere", run });

export const KILL_PRESENCE_CASES: readonly KillPresenceCase[] = [
	killCase("KILL-PRESENCE-01", "pause", "before", async (adapter) => {
		const medium = await claimed(adapter);
		const killed = await engine(adapter, medium, "before");
		await expectKilled(killed.presence.machineOffline(OWNER), "pause");
		const restarted = await engine(adapter, medium);
		expectSame(await records(restarted), [], "nothing of the pause is durable");
		expectSame(shape(restarted), { paused: false, state: "online" }, "the restarted session is not paused");
		await restarted.presence.machineOffline(OWNER);
		await restarted.presence.machineOffline(OWNER);
		expectSame(
			(await records(restarted)).map(({ kind }) => kind),
			[PRESENCE_PAUSE_RECORD],
			"one pause on re-observe",
		);
		expectSame(shape(restarted), pausedOnOwner, "the re-observed offline owner pauses the session");
	}),
	killCase("KILL-PRESENCE-02", "pause", "durable", async (adapter) => {
		const medium = await claimed(adapter);
		const killed = await engine(adapter, medium, "durable");
		await expectKilled(killed.presence.machineOffline(OWNER), "pause");
		const restarted = await engine(adapter, medium);
		const [pause] = await records(restarted);
		expectSame(
			(await records(restarted)).map(({ kind }) => kind),
			[PRESENCE_PAUSE_RECORD],
			"the pause is durable",
		);
		expectSame(shape(restarted), pausedOnOwner, "the restart recovers the open pause");
		await restarted.presence.machineOffline(OWNER);
		expectSame(await records(restarted), [pause], "a repeated offline signal adds no second pause");
		await restarted.presence.machineOnline(OWNER);
		const pauseId = pause?.id.slice(PRESENCE_PAUSE_RECORD.length + 1);
		expectSame(
			(await records(restarted)).map(({ id }) => id),
			[pause?.id, `${PRESENCE_RESUME_RECORD}:${pauseId}`],
			"the resume names the recovered pause",
		);
	}),
	killCase("KILL-PRESENCE-03", "resume", "before", async (adapter) => {
		const medium = await claimed(adapter);
		await (await engine(adapter, medium)).presence.machineOffline(OWNER);
		const killed = await engine(adapter, medium, "before");
		await expectKilled(killed.presence.machineOnline(OWNER), "resume");
		const restarted = await engine(adapter, medium);
		expectSame(
			(await records(restarted)).map(({ kind }) => kind),
			[PRESENCE_PAUSE_RECORD],
			"nothing of the resume",
		);
		expectSame(shape(restarted), pausedOnOwner, "the session is still paused after the restart");
		await restarted.presence.machineOnline(OWNER);
		await restarted.presence.machineOnline(OWNER);
		const kinds = (await records(restarted)).map(({ kind }) => kind);
		expectSame(kinds, [PRESENCE_PAUSE_RECORD, PRESENCE_RESUME_RECORD], "the resume is applied exactly once");
		expectSame(shape(restarted), { paused: false, state: "online" }, "the session runs again");
	}),
	killCase("KILL-PRESENCE-04", "resume", "durable", async (adapter) => {
		const medium = await claimed(adapter);
		await (await engine(adapter, medium)).presence.machineOffline(OWNER);
		const killed = await engine(adapter, medium, "durable");
		await expectKilled(killed.presence.machineOnline(OWNER), "resume");
		const restarted = await engine(adapter, medium);
		const kinds = [PRESENCE_PAUSE_RECORD, PRESENCE_RESUME_RECORD];
		expectSame(
			(await records(restarted)).map(({ kind }) => kind),
			kinds,
			"the resume is durable",
		);
		expectSame(shape(restarted), { paused: false, state: "online" }, "the restart finds no open pause");
		await restarted.presence.machineOnline(OWNER);
		expectSame(
			(await records(restarted)).map(({ kind }) => kind),
			kinds,
			"a repeated resume writes nothing",
		);
		await restarted.presence.ready(SESSION, "request");
	}),
	killCase("KILL-PRESENCE-05", "pause", "durable", async (adapter) => {
		const medium = await claimed(adapter);
		const survivor = await engine(adapter, medium, "durable");
		await expectKilled(survivor.presence.machineOffline(OWNER), "pause");
		await survivor.presence.machineOffline(OWNER);
		expectSame(
			(await records(survivor)).map(({ kind }) => kind),
			[PRESENCE_PAUSE_RECORD],
			"a retry adds no second pause",
		);
		expectSame(shape(survivor), pausedOnOwner, "the retry adopts the durable pause");
		await survivor.presence.machineOnline(OWNER);
		const kinds = [PRESENCE_PAUSE_RECORD, PRESENCE_RESUME_RECORD];
		expectSame(
			(await records(survivor)).map(({ kind }) => kind),
			kinds,
			"the one pause is resumed exactly once",
		);
		expectSame((await engine(adapter, medium)).presence.view(SESSION).paused, false, "no open pause is left");
	}),
];
