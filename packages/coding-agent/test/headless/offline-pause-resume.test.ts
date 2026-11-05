import { describe, expect, it } from "vitest";
import { createAdmissionLine } from "../../../agent/src/durable/store-admission.ts";
import { createMemoryStoreMedium, openMemoryStore } from "../../../agent/src/durable/store-memory.ts";
import { KILL_PRESENCE_CASES } from "../../src/modes/headless/testing/kill-presence.ts";
import { OWNER, startPresenceRig } from "./presence-host-support.ts";

const sessionIdOf = (opened: Record<string, unknown>): string => String(opened.sessionId);
const durableIdOf = (opened: Record<string, unknown>): string => String(Object(opened.state).sessionId);
const online = { placement: OWNER, state: "online", paused: false, waitingOn: [], held: 0 };

describe("offline pause and resume on a headless engine (SC-C2, K7)", () => {
	it("SC-C2(a): a client detach is not offline: the loop runs past the barrier and finishes", async () => {
		await using rig = await startPresenceRig();
		rig.connect("a");
		const opened = await rig.open("a", rig.fusedCwd);
		const turn = rig.prompt("a", sessionIdOf(opened), "a", ["barrier"]);
		await rig.barrierStarted;
		await rig.detach("a");
		rig.releaseBarrier();
		await rig.turnEnded(durableIdOf(opened));
		await turn;

		expect(rig.requests("a")).toEqual([0, 1]);
		expect(rig.presence.view(durableIdOf(opened))).toEqual(online);
		expect(await rig.storeRecords()).toEqual([]);
	}, 60_000);

	it("SC-C2(b): the owner offline holds the next provider request; a re-attaching client sees the placement offline and paused; reconnect resumes it exactly once", async () => {
		await using rig = await startPresenceRig();
		rig.connect("a");
		const file = await rig.newSessionFile(rig.fusedCwd);
		const opened = await rig.open("a", rig.fusedCwd, file);
		const durableId = durableIdOf(opened);
		const turn = rig.prompt("a", sessionIdOf(opened), "b", ["barrier"]);
		await rig.barrierStarted;
		await rig.detach("a");
		await rig.presence.machineOffline(OWNER);
		await rig.presence.machineOffline(OWNER);
		rig.releaseBarrier();
		await rig.untilView(durableId, (view) => view.held === 1);

		expect(rig.requests("b")).toEqual([0]);
		const paused = {
			placement: OWNER,
			state: "offline",
			paused: true,
			waitingOn: [{ machine: OWNER, role: "owner" }],
			held: 1,
		};
		rig.connect("b");
		const reopened = await rig.open("b", rig.fusedCwd, file);
		expect(sessionIdOf(reopened)).toBe(sessionIdOf(opened));
		expect(reopened.presence).toEqual(paused);
		expect((await rig.list("b")).map((row) => row.presence)).toEqual([paused]);

		await Promise.all([rig.presence.machineOnline(OWNER), rig.presence.machineOnline(OWNER)]);
		await rig.turnEnded(durableId);
		await turn;
		expect(rig.requests("b")).toEqual([0, 1]);
		expect((await rig.storeRecords()).map(({ kind }) => kind)).toEqual(["presence.pause", "presence.resume"]);
		expect(rig.presence.view(durableId)).toEqual(online);
	}, 60_000);

	it("SC-C2(c) MULTI: a required hand offline holds only its dependent session's tool calls; other sessions run; reconnect resumes it exactly once", async () => {
		await using rig = await startPresenceRig();
		rig.connect("c");
		const [a, b, c] = [
			await rig.open("c", rig.handCwd("hand-1")),
			await rig.open("c", rig.handCwd("hand-2")),
			await rig.open("c", rig.fusedCwd),
		];
		const turnA = rig.prompt("c", sessionIdOf(a), "ha", ["barrier", "hand_echo"]);
		await rig.barrierStarted;
		await rig.presence.machineOffline("hand-1");
		rig.releaseBarrier();
		await rig.untilView(durableIdOf(a), (view) => view.held === 1);
		expect(rig.requests("ha")).toEqual([0, 1]);
		expect(rig.handRuns).toEqual([]);

		await Promise.all([
			rig.prompt("c", sessionIdOf(b), "hb", ["hand_echo"]),
			rig.prompt("c", sessionIdOf(c), "hc", []),
		]);
		await Promise.all([rig.turnEnded(durableIdOf(b)), rig.turnEnded(durableIdOf(c))]);
		expect(rig.handRuns).toEqual(["hand-2"]);
		expect(rig.presence.view(durableIdOf(a))).toEqual({
			placement: OWNER,
			state: "online",
			paused: true,
			waitingOn: [{ machine: "hand-1", role: "hand" }],
			held: 1,
		});
		expect(rig.presence.view(durableIdOf(b))).toEqual(online);

		await Promise.all([rig.presence.machineOnline("hand-1"), rig.presence.machineOnline("hand-1")]);
		await rig.turnEnded(durableIdOf(a));
		await turnA;
		expect(rig.handRuns).toEqual(["hand-2", "hand-1"]);
		expect(rig.requests("ha")).toEqual([0, 1, 2]);
		const records = await rig.storeRecords();
		expect(records.map(({ kind }) => kind)).toEqual(["presence.pause", "presence.resume"]);
		expect(records.map(({ data }) => Object(data).sessionId)).toEqual([durableIdOf(a), durableIdOf(a)]);
	}, 60_000);

	it("a headless host without a presence binding reports no presence", async () => {
		await using rig = await startPresenceRig({ presence: false });
		rig.connect("a");
		const opened = await rig.open("a", rig.fusedCwd);
		expect(opened).not.toHaveProperty("presence");
		expect((await rig.list("a")).map((row) => Object.hasOwn(row, "presence"))).toEqual([false]);
	}, 60_000);
});

describe("KILL-PRESENCE on the durable store", () => {
	const media = new Map<string, ReturnType<typeof createMemoryStoreMedium>>();
	const adapter = {
		createAdmission: createAdmissionLine,
		createMedium: async () => {
			const name = `medium-${media.size}`;
			media.set(name, createMemoryStoreMedium());
			return name;
		},
		open: async (name: string, options?: Parameters<typeof openMemoryStore>[1]) => {
			const medium = media.get(name);
			if (medium === undefined) throw new Error(`no medium ${name}`);
			return openMemoryStore(medium, options);
		},
	};

	it.each(KILL_PRESENCE_CASES.map((killCase) => [killCase.id, killCase] as const))("%s", async (_id, killCase) => {
		await killCase.run(adapter);
	});
});
