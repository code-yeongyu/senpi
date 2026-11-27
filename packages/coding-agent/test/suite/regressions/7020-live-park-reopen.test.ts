/**
 * senpi#7020: a socket host reopens the retained sessions a previous host left in its park record. The record now
 * says whether the session was loaded when that host ended (`live`): a resident stamp, a handoff drain park and a
 * clean stop are; an idle-sweep park and an unload are not. A live session comes back exactly as the last host left
 * it, releasing only the hold the restart itself caused (the drain's); anything else reopens dormant, as before.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendHistoricalEngineStarts,
	cleanupParkHosts,
	liveOf,
	parkedEntry,
	parkHost,
	parkScratch,
	reopenOnSuccessor,
	within,
} from "./7020-live-park-support.ts";

afterEach(cleanupParkHosts);

const TURN_MS = 10_000;
const peer = (id: string) => ({ delivery_id: id, text: "[from lead] go on", deliverAs: "followUp" as const });

describe("the park record says whether the session was live when its host ended", () => {
	it("is live while open, after a handoff drain park and after a clean stop", async () => {
		const { dir, daemonDir, sessionPath } = await parkScratch();
		const host = await parkHost(dir, daemonDir);
		await host.open(sessionPath);
		expect(liveOf(await parkedEntry(daemonDir, sessionPath))).toBe(true);
		await host.detach();
		await host.router.beginDrain();
		await host.waitForLine('"handoff_parked"');
		expect(liveOf(await parkedEntry(daemonDir, sessionPath))).toBe(true);

		const stopped = await parkScratch();
		const stopping = await parkHost(stopped.dir, stopped.daemonDir);
		await stopping.open(stopped.sessionPath);
		await stopping.dispose();
		expect(liveOf(await parkedEntry(stopped.daemonDir, stopped.sessionPath))).toBe(true);
	});

	it("is not live after an idle-sweep park or an unload", async () => {
		const { dir, daemonDir, sessionPath } = await parkScratch();
		const host = await parkHost(dir, daemonDir);
		await host.open(sessionPath);
		await host.idleSweep();
		expect(liveOf(await parkedEntry(daemonDir, sessionPath))).toBeUndefined();

		const unloaded = await parkScratch();
		const unloading = await parkHost(unloaded.dir, unloaded.daemonDir);
		const sessionId = await unloading.open(unloaded.sessionPath);
		const parked = unloading.waitForLine('"unloaded"');
		await unloading.send({ type: "unload_session", id: "unload", sessionId });
		await parked;
		expect(liveOf(await parkedEntry(unloaded.daemonDir, unloaded.sessionPath))).toBeUndefined();
	});
});

// Gate 2: the handoff drain held the session's automatic turns so its running turn was its last on the old host. The
// successor releases that hold and nothing else: the wake held during the drain is delivered, with no client.
it("a session the handoff drain held resumes on the successor by itself and delivers the wake held during the drain", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const barrier = {
		name: "barrier",
		label: "Barrier",
		description: "Wait for the test to release the running turn.",
		parameters: Type.Object({}),
		execute: async () => {
			entered.resolve();
			await release.promise;
			return { content: [{ type: "text" as const, text: "released" }], details: {} };
		},
	};
	const { dir, daemonDir, sessionPath } = await parkScratch();
	const host = await parkHost(dir, daemonDir, {
		tools: [barrier],
		responses: () => [
			fauxAssistantMessage([fauxToolCall("barrier", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		],
	});
	await host.open(sessionPath);
	appendHistoricalEngineStarts(host.harness);
	const running = host.inScope(() =>
		host.session.sendCustomMessage(
			{ customType: "senpi-monitor:event", content: "deploy started", display: false },
			{ triggerTurn: true },
		),
	);
	await within(entered.promise, TURN_MS, "the running turn");
	await host.detach();
	const held = new Promise<void>((resolve) => {
		const unsubscribe = host.session.subscribe((event) => {
			if (event.type !== "session_paused") return;
			unsubscribe();
			resolve();
		});
	});
	await host.router.beginDrain();
	await within(held, TURN_MS, "the drain's hold");
	await host.inScope(() =>
		host.session.sendCustomMessage(
			{ customType: "senpi-monitor:event", content: "deploy finished", display: false },
			{ triggerTurn: true },
		),
	);
	const parked = host.waitForLine('"handoff_parked"');
	release.resolve();
	await within(running, TURN_MS, "the running turn's end");
	await within(parked, TURN_MS, "the drain park");

	const successor = await reopenOnSuccessor(dir, daemonDir, await parkedEntry(daemonDir, sessionPath));
	await within(successor.firstTurn, TURN_MS, "the successor's first turn");
	expect(successor.harness.faux.state.callCount).toBe(1);
	expect(successor.session.holds).toEqual([]);
	expect(
		successor.session.messages.some(
			(message) => message.role === "custom" && JSON.stringify(message.content).includes("deploy finished"),
		),
	).toBe(true);
});

// Gate 4: a person's Stop is not the restart's to release. The live reopen drops the drain hold and keeps the Stop.
it("a live reopen keeps a person's Stop: the session stays paused and a peer is told held by the Stop alone", async () => {
	const { dir, daemonDir, sessionPath } = await parkScratch();
	const host = await parkHost(dir, daemonDir);
	await host.open(sessionPath);
	await host.session.stop();
	await host.detach();
	await host.router.beginDrain();
	await host.waitForLine('"handoff_parked"');

	const successor = await reopenOnSuccessor(dir, daemonDir, await parkedEntry(daemonDir, sessionPath));
	expect(successor.session.paused).toBe(true);
	expect(successor.inScope(() => successor.session.externalAdmission.admit(peer("stopped-1")))).toEqual({
		kind: "held",
		holds: ["session_hold"],
		turn_epoch: 0,
	});
	await successor.session.waitForIdle();
	expect(successor.harness.faux.state.callCount).toBe(0);
	expect(successor.session.holds.map((hold) => hold.kind)).toEqual(["session_hold"]);
});

it("a live reopen keeps an unattended hold the session already had: only the drain's hold is the restart's", async () => {
	const { dir, daemonDir, sessionPath } = await parkScratch();
	const host = await parkHost(dir, daemonDir);
	await host.send({ type: "open_session", sessionPath, cwd: dir, retain_on_disconnect: true, attended: false });
	await host.detach();
	await host.router.beginDrain();
	await host.waitForLine('"handoff_parked"');

	const successor = await reopenOnSuccessor(dir, daemonDir, await parkedEntry(daemonDir, sessionPath));
	await successor.inScope(() =>
		successor.session.sendCustomMessage(
			{ customType: "senpi-monitor:event", content: "build finished", display: false },
			{ triggerTurn: true },
		),
	);
	expect(successor.harness.faux.state.callCount).toBe(0);
	expect(successor.session.paused).toBe(true);
	expect(successor.session.holds.map((hold) => hold.key)).toEqual(["unattended"]);
});
