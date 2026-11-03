/**
 * senpi#5612: a delivery consumed inside a still-running run stayed in `waitingOn.background` until the run ended,
 * and every `session-lifecycle` record re-serialized all of them, so one long run's transcript grew with the square
 * of its deliveries (one session reached 3.67 GB). A consumed delivery is no longer a wait, and a record carries only
 * the background sources that changed, so the bytes each state change writes stay flat however many deliveries arrive.
 */
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import type { LifecycleWaits } from "../../../src/core/session-lifecycle-types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

interface Growth {
	readonly records: number;
	readonly bytes: number;
	readonly bytesPerRecord: number;
	readonly largestRecord: number;
	readonly maxNamedBackground: number;
	readonly maxBackgroundTotal: number;
}

async function oneRunOfDeliveries(n: number, deliverAs: "steer" | "followUp"): Promise<Growth> {
	let api: ExtensionAPI | undefined;
	const deliver: AgentTool = {
		name: "deliver",
		label: "deliver",
		description: "delivers one wake",
		parameters: Type.Object({}),
		execute: async () => {
			api?.sendMessage({ customType: "wake", content: "wake", display: false }, { deliverAs });
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	};
	const harness = await createHarness({
		persistSession: true,
		tools: [deliver],
		extensionFactories: [
			(pi: ExtensionAPI) => {
				api = pi;
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "rpc", shutdownHandler: () => {} });
	harness.setResponses([
		...Array.from({ length: n }, () =>
			fauxAssistantMessage([fauxToolCall("deliver", {})], { stopReason: "toolUse" }),
		),
		fauxAssistantMessage([fauxText("done")]),
	]);
	await harness.session.prompt("go");
	const records = harness.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom" && entry.customType === "session-lifecycle" ? [entry] : []));
	const sizes = records.map((entry) => Buffer.byteLength(JSON.stringify(entry)));
	const waits = records.map((entry) => (entry.data as { readonly waitingOn?: LifecycleWaits }).waitingOn);
	const bytes = sizes.reduce((sum, size) => sum + size, 0);
	return {
		records: records.length,
		bytes,
		bytesPerRecord: bytes / records.length,
		largestRecord: Math.max(...sizes),
		maxNamedBackground: Math.max(...waits.map((wait) => wait?.background.length ?? 0)),
		maxBackgroundTotal: Math.max(
			...waits.map((wait) => (wait?.background.length ?? 0) + (wait?.backgroundOmitted ?? 0)),
		),
	};
}

it("a steered delivery leaves waitingOn.background the moment it is consumed, so bytes per state change stay flat", async () => {
	// Given one running run that consumes 50, 100 and 200 steered deliveries.
	const [n50, n100, n200] = [
		await oneRunOfDeliveries(50, "steer"),
		await oneRunOfDeliveries(100, "steer"),
		await oneRunOfDeliveries(200, "steer"),
	];

	// Then no record waits on more than the one delivery still in flight.
	expect(n200.maxBackgroundTotal).toBeLessThanOrEqual(1);
	expect(n200.maxNamedBackground).toBe(0);
	// And each state change writes the same bytes at every N, so the transcript grows linearly.
	expect(n200.bytesPerRecord / n50.bytesPerRecord).toBeLessThan(1.1);
	expect(n200.largestRecord / n50.largestRecord).toBeLessThan(1.1);
	expect(n100.bytes / n50.bytes).toBeLessThan(2.1);
	expect(n200.bytes / n100.bytes).toBeLessThan(2.1);
});

it("genuinely queued followUps are counted in full while each record carries only what changed", async () => {
	// Given one running run that queues 50, 100 and 200 followUps it has not consumed yet.
	const [n50, n100, n200] = [
		await oneRunOfDeliveries(50, "followUp"),
		await oneRunOfDeliveries(100, "followUp"),
		await oneRunOfDeliveries(200, "followUp"),
	];

	// Then every queued followUp is still a wait, reported by its true count.
	expect(n200.maxBackgroundTotal).toBe(200);
	// But a record carries only the followUp that changed, so its size does not grow with the queue.
	expect(n200.maxNamedBackground).toBe(0);
	expect(n200.bytesPerRecord / n50.bytesPerRecord).toBeLessThan(1.1);
	expect(n200.largestRecord / n50.largestRecord).toBeLessThan(1.1);
	expect(n100.bytes / n50.bytes).toBeLessThan(2.1);
	expect(n200.bytes / n100.bytes).toBeLessThan(2.1);
});
