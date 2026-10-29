import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";
import { opened } from "../rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";

// senpi#3114. A handoff drain parks a session only once it is idle. An unattended session (its client is gone,
// so nobody can steer or cancel it on this superseded generation) chained automatic turns - goal continuation,
// monitor and codemode wakes - back to back, never went idle and kept running, its eval cells included, on a
// generation nothing could reach. The drain now holds automatic turns of every session nobody is attached to,
// so the in-flight run is the last one and the session parks when it settles.

const scratchDirs: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
	for (const h of harnesses.splice(0).reverse()) h.cleanup();
	for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const wake = { customType: "senpi-monitor:event", content: "continue", display: false };

it("a drained session starts no further automatic turn once its running turn settles", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const h = await createHarness({
		tools: [
			{
				name: "barrier",
				label: "Barrier",
				description: "Wait for the test to release the running turn.",
				parameters: Type.Object({}),
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "released" }], details: {} };
				},
			},
		],
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage([fauxToolCall("barrier", {})], { stopReason: "toolUse" }),
		...Array.from({ length: 5 }, () => fauxAssistantMessage([fauxText("done")])),
	]);
	const running = h.session.sendCustomMessage(wake, { triggerTurn: true });
	await entered.promise;

	h.session.holdAutomaticTurns();
	// A wake arriving during the held run is kept as a notice instead of extending the run.
	await h.session.sendCustomMessage(wake, { triggerTurn: true, deliverAs: "followUp" });
	release.resolve();
	await running;
	const callsAfterRun = h.faux.state.callCount;

	// The chained wake that used to start the next turn on the old generation.
	await h.session.sendCustomMessage(wake, { triggerTurn: true });
	expect(h.faux.state.callCount).toBe(callsAfterRun);
	expect(h.session.isStreaming).toBe(false);
	expect(h.session.isSessionBusy).toBe(false);
});

it("the drain holds automatic turns of unattended sessions only", async () => {
	const dir = await mkdtemp(join(tmpdir(), "senpi-3114-"));
	scratchDirs.push(dir);
	const exited = Promise.withResolvers<void>();
	const rig = createInProcessRig(dir, { onEmptyExit: () => exited.resolve() });
	const unattended = opened(
		await rig.open("gone", { cwd: dir, sessionPath: join(dir, "child.jsonl"), retain_on_disconnect: true }),
		0,
	).sessionId;
	const attended = opened(await rig.open("live", { cwd: dir, sessionPath: join(dir, "top.jsonl") }), 1).sessionId;
	const childTurn = rig.turns.get(join(dir, "child.jsonl"));
	const topTurn = rig.turns.get(join(dir, "top.jsonl"));
	if (childTurn === undefined || topTurn === undefined) throw new Error("rig turns missing");
	// Both are mid-turn, so the drain's first pass cannot park either of them.
	childTurn.start();
	topTurn.start();
	await rig.drop("gone");
	expect(rig.registry.peek(unattended)?.attachments).toBe(0);

	rig.router.beginDrain();
	await rig.settle();

	expect(childTurn.automaticTurnHolds).toBe(1);
	expect(topTurn.automaticTurnHolds).toBe(0);
	expect(rig.registry.peek(unattended)).toBeDefined();
	expect(rig.registry.peek(attended)).toBeDefined();

	childTurn.finish();
	topTurn.finish();
	await rig.drop("live");
	await exited.promise;
	await rig.settle();
	expect(rig.registry.size).toBe(0);
}, 10_000);
