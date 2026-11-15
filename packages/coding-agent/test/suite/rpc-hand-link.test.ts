/**
 * senpi#5924 (R3 tool-relay mode): a hosted brain's packets arrive as `hand_link` records on a delegated connection,
 * and the RPC host runs them on this machine's hand, the same engine as `--hand`. Records travel over a real Unix
 * socket through the bare host's public-key filter; the brain is agent-core's cross-machine remote ToolHost.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { DelegatedHost } from "./rpc-delegated-host-support.ts";
import {
	BRAIN_A,
	batch,
	brain,
	brainPeer,
	call,
	type HandProbe,
	handLinkHost,
	handProbe,
	pump,
	resultText,
} from "./rpc-hand-link-support.ts";

let host: DelegatedHost | undefined;
afterEach(async () => {
	await host?.dispose();
	host = undefined;
}, 60_000);

async function start(probe: HandProbe = handProbe()) {
	host = await handLinkHost(probe);
	return { host, peer: await brainPeer(host, BRAIN_A) };
}

it("runs a brain's tool call on this machine's hand through hand_link batches", async () => {
	const { host, peer } = await start();
	const brainA = brain("hosted-1", 1);

	const result = await pump(peer, brainA, call(brainA, host.cwd, "count", {}));

	expect(resultText(result)).toBe(`counted in ${host.cwd}`);
	expect(readFileSync(join(host.cwd, "count.txt"), "utf8")).toBe("x");
}, 60_000);

it("answers each batch while a tool runs, so a following batch's abort reaches the running call (LOW-8)", async () => {
	const probe = handProbe();
	const { host, peer } = await start(probe);
	const brainA = brain("hosted-1", 1);
	const abort = new AbortController();
	const running = call(brainA, host.cwd, "wait_abort", {}, abort.signal);

	await pump(peer, brainA, probe.started.promise);
	expect(probe.aborted).toBe(false);
	abort.abort();
	const result = await pump(peer, brainA, running);

	expect(probe.aborted).toBe(true);
	expect(result.messages).toHaveLength(1);
}, 60_000);

it("carries a frame over the part size both ways as data_part packets, and says more while parts wait", async () => {
	const { host, peer } = await start();
	const brainA = brain("hosted-1", 1);
	const text = "0123456789abcdef".repeat(48 * 1024);
	const echoed = call(brainA, host.cwd, "echo", { text });
	let settled = false;
	void echoed.finally(() => {
		settled = true;
	});
	const more: unknown[] = [];

	while (!settled) more.push(((await batch(peer, brainA)).data as { more: unknown }).more);

	expect(resultText(await echoed)).toBe(text);
	expect(more).toContain(true);
	expect(more.every((value) => typeof value === "boolean")).toBe(true);
}, 60_000);

it("ends the session's link on a malformed packet; only a higher generation opens it again", async () => {
	const { host, peer } = await start();
	const brainA = brain("hosted-1", 1);
	await pump(peer, brainA, call(brainA, host.cwd, "count", {}));
	const send = (packets: unknown[]) =>
		peer.send({ type: "hand_link", session: "hosted-1", loop: brainA.loop, instance: brainA.link.instance, packets });

	expect(
		await send([
			{ kind: "data_part", lane: "x", seq: 9, index: 0, count: 2, payload: "" },
			{ kind: "data_part", lane: "x", seq: 9, index: 1, count: 3, payload: "" },
		]),
	).toMatchObject({ error: "hand_link_malformed" });
	expect(await send([])).toMatchObject({ error: "hand_link_superseded" });
	expect(await send([{ kind: "data", lane: "x", seq: 1 }])).toMatchObject({ error: "hand_link_superseded" });

	const brainNext = brain("hosted-1", 2);
	await pump(peer, brainNext, call(brainNext, host.cwd, "count", {}));
	expect(readFileSync(join(host.cwd, "count.txt"), "utf8")).toBe("xx");
	expect(await batch(peer, brainNext)).toMatchObject({ success: true });
}, 60_000);
