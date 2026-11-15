// senpi#5924 review round 2 (M1, L5): two hand_link endpoints share one state file, as a predecessor daemon and its
// successor do during a handover. The successor's claim alone ends the predecessor's live links and aborts their
// running calls, with no further predecessor batch; the successor cannot take over the same generation while the
// predecessor's link there may still run; and a commit the store refuses `stale-epoch` reads as a superseded host.
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { encodeHandPackets } from "../../src/modes/hand/hand-packet-codec.ts";
import { createHandLinkEndpoint, type HandLinkEndpoint } from "../../src/modes/rpc/hand-link-endpoint.ts";
import { handLinkStatePath } from "../../src/modes/rpc/hand-link-state.ts";
import { type LockedFileStore, openLockedFileStore } from "../../src/modes/rpc/locked-file-store.ts";
import { afterEach, expect, it } from "vitest";
import { cleanupHands, handConfiguration, handDirs } from "../hand/remote-hand-fixture.ts";
import { type Brain, brain, call, type HandProbe, handProbe, probeTools } from "../suite/rpc-hand-link-support.ts";

const SENDER = "hb-brain-a";
const endpoints: HandLinkEndpoint[] = [];
afterEach(async () => {
	await Promise.allSettled(endpoints.splice(0).map((endpoint) => endpoint.close()));
	await cleanupHands();
});

async function send(endpoint: HandLinkEndpoint, from: Brain) {
	const packets = from.outgoing.splice(0).flatMap((message) => encodeHandPackets(message) ?? []);
	const { instance } = from.link;
	const answer = await endpoint.link(SENDER, {
		session: from.session,
		loop: from.loop,
		packets,
		...(instance === undefined ? {} : { instance }),
	});
	if (answer.kind === "packets") {
		from.link.instance = answer.instance;
		for (const wire of answer.packets) {
			const packet = from.read(wire);
			if (packet === undefined) throw new Error("malformed packet from the hand");
			if (packet !== null) from.side.message(packet);
		}
	}
	return answer;
}

async function pumpUntil<T>(endpoint: HandLinkEndpoint, from: Brain, until: Promise<T>): Promise<T> {
	let settled = false;
	const done = until.finally(() => {
		settled = true;
	});
	while (!settled) {
		const answer = await send(endpoint, from);
		if (answer.kind !== "packets") throw new Error(`refused: ${answer.reason}`);
	}
	return done;
}

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
	});
	return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function setup(prefix: string) {
	const dirs = await handDirs(prefix);
	const statePath = handLinkStatePath(dirs.agentDir);
	const endpoint = (probe: HandProbe, openStore: () => LockedFileStore = () => openLockedFileStore(statePath)) => {
		const created = createHandLinkEndpoint({
			openHand: () =>
				createLooplessHand(handConfiguration(dirs), {
					twoSidedHome: "hand",
					extensionFactories: [probeTools(probe)],
				}),
			openStore,
			report: () => {},
		});
		endpoints.push(created);
		return created;
	};
	return { dirs, statePath, endpoint };
}

it("a successor's claim aborts the predecessor's running call with no further predecessor batch", async () => {
	const { dirs, endpoint } = await setup("supersede");
	const probe = handProbe();
	const predecessor = endpoint(probe);
	const first = brain("hosted-1", 1);
	void call(first, dirs.cwd, "wait_abort", {});
	await pumpUntil(predecessor, first, probe.started.promise);

	const successor = endpoint(handProbe());
	const sameGeneration = brain("hosted-1", 1);
	expect(await send(successor, sameGeneration)).toEqual({ kind: "refused", reason: "hand_link_instance_mismatch" });
	const moved = brain("hosted-1", 2);
	await pumpUntil(successor, moved, call(moved, dirs.cwd, "count", {}));

	await within(probe.abortSeen.promise, 10_000, "the predecessor's abort");
	expect(probe.aborted).toBe(true);
	expect(await send(predecessor, first)).toEqual({ kind: "refused", reason: "hand_link_host_superseded" });
}, 60_000);

it("a commit refused stale-epoch reads as a superseded host, before any watch has noticed", async () => {
	const { dirs, statePath, endpoint } = await setup("stale-epoch");
	const unwatched = (): LockedFileStore => ({ ...openLockedFileStore(statePath), watchOwner: () => () => {} });
	const host = endpoint(handProbe(), unwatched);
	const first = brain("hosted-1", 1);
	await pumpUntil(host, first, call(first, dirs.cwd, "count", {}));

	await openLockedFileStore(statePath).claimFor("another-daemon");

	expect(await send(host, brain("hosted-1", 2))).toEqual({ kind: "refused", reason: "hand_link_host_superseded" });
}, 60_000);
