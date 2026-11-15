/**
 * senpi#5924: the `hand_link` endpoint fences each hosted session by its loop generation (the brain's `RemoteFloor`
 * epoch), and the sender every check sees is the delegated connection's principal, never a field of the record.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { handLinkStatePath } from "../../src/modes/rpc/hand-link-state.ts";
import type { DelegatedHost } from "./rpc-delegated-host-support.ts";
import {
	BRAIN_A,
	BRAIN_B,
	batch,
	brain,
	brainPeer,
	call,
	handLinkHost,
	handProbe,
	pump,
	resultText,
	untilRefused,
} from "./rpc-hand-link-support.ts";

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

it("a newer generation from the session's new owner tears down the old link, and the old owner is refused", async () => {
	const probe = handProbe();
	host = await handLinkHost(probe);
	const [peerA, peerB] = [await brainPeer(host, BRAIN_A), await brainPeer(host, BRAIN_B)];
	const brainA = brain("hosted-1", 1);
	void call(brainA, host.cwd, "wait_abort", {});
	await pump(peerA, brainA, probe.started.promise);

	const brainB = brain("hosted-1", 2);
	const result = await pump(peerB, brainB, call(brainB, host.cwd, "count", {}));

	expect(resultText(result)).toBe(`counted in ${host.cwd}`);
	expect(probe.aborted).toBe(true);
	expect(await batch(peerA, brainA)).toMatchObject({ success: false, error: "hand_link_superseded" });
	const stale = brain("hosted-1", 2, { loopId: brainB.loop.id });
	expect(await batch(peerA, stale)).toMatchObject({ success: false, error: "hand_link_generation_taken" });
	expect(await batch(peerB, brain("hosted-1", 2, { loopId: "another-loop" }))).toMatchObject({
		success: false,
		error: "hand_link_generation_taken",
	});
}, 60_000);

it("a session naming a scope another session holds ends its own link", async () => {
	host = await handLinkHost();
	const [peerA, peerB] = [await brainPeer(host, BRAIN_A), await brainPeer(host, BRAIN_B)];
	const first = brain("hosted-1", 1);
	await pump(peerA, first, call(first, host.cwd, "count", {}));

	const intruder = brain("hosted-2", 1, { scope: first.scope });
	void call(intruder, host.cwd, "count", {});

	expect(await untilRefused(peerB, intruder)).toMatchObject({ error: "hand_link_scope_taken" });
	expect(await batch(peerB, intruder)).toMatchObject({ error: "hand_link_superseded" });
	expect(resultText(await pump(peerA, first, call(first, host.cwd, "count", {})))).toBe(`counted in ${host.cwd}`);
}, 60_000);

it("takes hand_link only from a delegated connection granted the hand_link class", async () => {
	host = await handLinkHost();
	const record = { type: "hand_link", session: "hosted-1", loop: { id: "loop-1", generation: 1 }, packets: [] };

	expect(await (await host.proven()).send(record)).toMatchObject({ error: "hand_link_not_delegated" });
	const admin = await brainPeer(host, BRAIN_A, ["observe", "drive", "answer", "thread", "device_admin"]);
	expect(await admin.send(record)).toMatchObject({
		errorCode: "delegation_not_granted",
		errorData: { class: "hand_link" },
	});
	const granted = await brainPeer(host, BRAIN_A);
	expect(await granted.send(record)).toMatchObject({ success: true, data: { packets: expect.any(Array) } });
	expect(await granted.send({ ...record, loop: { id: "loop-1", generation: 0 } })).toMatchObject({
		error: "hand_link_malformed",
	});
}, 60_000);

it("admits a batch only for the link instance its brain last saw", async () => {
	host = await handLinkHost();
	const peer = await brainPeer(host, BRAIN_A);
	const hosted = brain("hosted-1", 1);
	await pump(peer, hosted, call(hosted, host.cwd, "count", {}));
	const record = { type: "hand_link", session: "hosted-1", loop: hosted.loop, packets: [] };

	expect(await peer.send({ ...record, instance: "another-link" })).toMatchObject({
		error: "hand_link_instance_mismatch",
	});
	expect(await peer.send(record)).toMatchObject({ error: "hand_link_instance_mismatch" });
	expect(await peer.send({ ...record, instance: hosted.link.instance })).toMatchObject({
		success: true,
		data: { instance: hosted.link.instance },
	});
}, 60_000);

it("close retires the session: its scope and floor leave the state, and every later batch is refused", async () => {
	host = await handLinkHost();
	const peer = await brainPeer(host, BRAIN_A);
	const hosted = brain("hosted-1", 1);
	await pump(peer, hosted, call(hosted, host.cwd, "count", {}));
	const keys = () =>
		(
			JSON.parse(readFileSync(handLinkStatePath(join(host?.scratch ?? "", "agent")), "utf8")) as {
				documents: [string, unknown][];
			}
		).documents.map(([key]) => key);
	expect(keys()).toEqual(
		expect.arrayContaining([`hand-link.scope:${hosted.scope}`, `hand.epoch-floor:${hosted.scope}`]),
	);

	const closing = { type: "hand_link", session: "hosted-1", loop: hosted.loop, instance: hosted.link.instance };
	expect(await peer.send({ ...closing, packets: [], close: true })).toMatchObject({ success: true });

	expect(keys().filter((key) => key.includes(hosted.scope))).toEqual([]);
	expect(await batch(peer, brain("hosted-1", 2))).toMatchObject({ error: "hand_link_session_closed" });
}, 60_000);
