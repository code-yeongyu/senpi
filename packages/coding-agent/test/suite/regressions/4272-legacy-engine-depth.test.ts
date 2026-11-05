import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { COMPACT_PROTOCOL_MAX_DEPTH } from "../../../src/modes/rpc/compact-protocol-depth.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { builtFauxPath, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

// Part of #4272 (S11a, RULING-68): the legacy JSONL writer keeps today's behaviour (no protocol depth limit for a legacy
// client). senpi#5702 (LEAD ruling, superseding RULING-68's refusal past the engine limit): the writer no longer has an
// engine limit either - a record past the runtime's recursive JSON path is serialized by an explicit-stack writer and
// delivered whole, nothing is refused or counted, the session keeps running and later records arrive.

type Deep = string | Date | Deep[];
const nest = (depth: number, leaf: string | Date = "leaf"): Deep => {
	let value: Deep = leaf;
	for (let level = 0; level < depth; level++) value = [value];
	return value;
};
const serializes = (depth: number): boolean => {
	try {
		// Date.toJSON selects the native recursive path even when plain arrays serialize iteratively (Node 26).
		JSON.stringify(nest(depth, new Date(0)));
		return true;
	} catch (error) {
		if (error instanceof RangeError && error.message.startsWith("Maximum call stack size exceeded")) return false;
		throw error;
	}
};
/** The recursive JSON path's limit, not a limit on plain JSON or on the legacy protocol. */
function engineLimit(): number {
	let low = 1;
	let high = 2;
	while (serializes(high)) {
		// A fixture budget, not a protocol cap: fail instead of allocating until OOM if the engine changes again.
		if (high >= 65_536) throw new Error("JSON depth fixture did not reach a native stack overflow");
		[low, high] = [high, high * 2];
	}
	while (high - low > 1) {
		const middle = (low + high) >> 1;
		if (serializes(middle)) low = middle;
		else high = middle;
	}
	return low;
}
const LIMIT = engineLimit();
// Calibrated stack depth varies with the call site and JIT. This bounded fixture exceeds either thread's
// recursive path without assuming that a plain JSON value has the same limit (Node 26's path is iterative).
const OVER_ENGINE = 65_536;
const OVER_PROTOCOL = 2 * COMPACT_PROTOCOL_MAX_DEPTH;
const REFUSED =
	/^senpi rpc host: legacy record refused: tool_execution_update nests deeper than this runtime's JSON engine limit \(session [^)]+\)\n$/;
const isUpdate = (record: WireRecord) => record.type === "tool_execution_update" && record.toolName === "deep_update";
const endOf = (records: readonly WireRecord[]) => records.find((record) => record.type === "tool_execution_end");

afterEach(() => {
	vi.restoreAllMocks();
});

it(`runs on ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`} (engine limit ${LIMIT})`, () => {
	expect(OVER_PROTOCOL + 4, "the no-restriction depth is over the protocol limit and under the engine's").toBeLessThan(
		LIMIT,
	);
});

/** A real in-process host session whose tool streams one partial result `depth` deep, then answers. */
async function inProcess(depth: number, leaf: string | Date = "leaf") {
	await using host = await statusHost();
	const client = host.client("legacy");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const pi = [...host.extensionApis.values()].at(-1);
	if (!pi) throw new Error("no session extension API");
	pi.registerTool({
		name: "deep_update",
		label: "Deep update",
		description: "Streams one deep partial result.",
		parameters: Type.Object({}),
		execute: async (_id, _params, _signal, onUpdate) => {
			onUpdate?.({ content: [{ type: "text", text: "partial" }], details: nest(depth, leaf) });
			return { content: [{ type: "text", text: "returned" }], details: {} };
		},
	});
	host.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("deep_update", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("after the deep update"),
	]);
	const stderr: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => stderr.push(String(chunk)) > 0);
	const ended = client.waitFor((record) => record.type === "agent_end");
	expect((await client.request({ type: "prompt", sessionId, message: "go" })).success).toBe(true);
	await ended;
	await host.writer.flush();
	const ends = () => client.inbox.filter((record) => record.type === "agent_end").length;
	const next = client.waitFor((record) => record.type === "agent_end" && ends() === 2);
	host.faux.setResponses([fauxAssistantMessage("the session keeps running")]);
	expect((await client.request({ type: "prompt", sessionId, message: "again" })).success).toBe(true);
	await next;
	return { records: [...client.inbox], refusals: Reflect.get(host.writer, "legacyRefusals")?.count, stderr };
}

it("RULING-68 a record over the protocol depth limit but under the engine limit reaches a legacy client unchanged", async () => {
	const { records, refusals, stderr } = await inProcess(OVER_PROTOCOL);
	const update = records.find(isUpdate);
	expect(JSON.stringify((update?.partialResult as { details?: unknown } | undefined)?.details)).toBe(
		JSON.stringify(nest(OVER_PROTOCOL)),
	);
	expect(refusals ?? 0).toBe(0);
	expect(stderr.filter((line) => REFUSED.test(line))).toEqual([]);
}, 600_000);

/** One real delivery per probe, including the refusal/reporting and two-turn survival contract. */
async function writerDelivers(depth: number, expectedDelivered?: boolean): Promise<boolean> {
	const { records, refusals, stderr } = await inProcess(depth, new Date(0));
	const updates = records.filter(isUpdate);
	const delivered = updates.length === 1;
	if (expectedDelivered !== undefined) expect(updates).toHaveLength(expectedDelivered ? 1 : 0);
	else expect(updates.length).toBeLessThanOrEqual(1);
	if (delivered) {
		let details = (updates[0]?.partialResult as { details?: unknown } | undefined)?.details;
		let levels = 0;
		while (Array.isArray(details)) {
			expect(details).toHaveLength(1);
			details = details[0];
			levels++;
		}
		expect(levels).toBe(depth);
		expect(details).toBe(new Date(0).toISOString());
	}
	expect(endOf(records), "the tool that produced it was not broken by the legacy writer").toMatchObject({
		isError: false,
		result: { content: [{ type: "text", text: "returned" }] },
	});
	expect(refusals ?? 0, "refusals counted exactly").toBe(delivered ? 0 : 1);
	expect(
		stderr.filter((line) => REFUSED.test(line)),
		"refusals reported exactly",
	).toHaveLength(delivered ? 0 : 1);
	expect(
		records.filter((record) => record.type === "agent_end"),
		"later records, both turns",
	).toHaveLength(2);
	return delivered;
}

it("senpi#5702 (supersedes RULING-105's floor): the native limit, half of it, and 65,536 levels are all delivered whole", async () => {
	// RULING-105 bisected the writer's refusal depth against the native probe LIMIT. The writer has no refusal depth
	// any more, so every depth on both sides of the native limit is delivered, uncounted and unreported.
	for (const depth of [Math.floor(LIMIT / 2), LIMIT, LIMIT + 1, OVER_ENGINE])
		expect(await writerDelivers(depth, true), `${depth} levels delivered (native limit ${LIMIT})`).toBe(true);
}, 300_000);

const isolatePrelude = `
const nest = (depth, leaf = "leaf") => { let value = leaf; for (let level = 0; level < depth; level++) value = [value]; return value; };`;
const deepTool = (depths: string) => `(() => {
	pi.registerTool({
		name: "deep_update",
		label: "Deep update",
		description: "Streams deep partial results.",
		parameters: { type: "object", properties: {} },
		execute: async (_id, _params, _signal, onUpdate) => {
			for (const [depth, leaf] of ${depths}) onUpdate?.({ content: [{ type: "text", text: "partial" }], details: nest(depth, leaf) });
			return { content: [{ type: "text", text: "returned" }], details: {} };
		},
	});
	return [fauxAssistantMessage([fauxToolCall("deep_update", {})], { stopReason: "toolUse", timestamp: 1 }), answer(), answer()];
})()`;

/** A real session worker whose tool streams partial results at `depths` (source evaluated in the isolate). */
async function inWorker(depths: string) {
	const host = await workerAcceptanceHost(builtFauxPath, isolatePrelude, deepTool(depths));
	try {
		const { sessionId, worker } = await host.open();
		const refused = Promise.withResolvers<string>();
		worker.worker.stderr?.on("data", (chunk: Buffer) => {
			const line = String(chunk)
				.split(/(?<=\n)/)
				.find((text) => text.startsWith("senpi rpc host: legacy record refused"));
			if (line !== undefined) refused.resolve(line);
		});
		const stderr: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => stderr.push(String(chunk)) > 0);
		for (const message of ["go deep", "again"]) {
			const idle = host.next(`idle after ${message}`, (record) => record.type === "agent_idle");
			expect((await host.request({ type: "prompt", sessionId, message })).success).toBe(true);
			await idle;
		}
		await host.writer.flush();
		const refusals = Reflect.get(host.writer, "legacyRefusals")?.count ?? 0;
		return {
			records: [...host.records],
			failures: [...host.failures],
			refusals,
			stderr,
			isolateRefusal: refused.promise,
		};
	} finally {
		await host.dispose();
	}
}

/** The levels of a delivered `nest(depth, new Date(0))`, walked (native JSON of it overflows on Node 24). */
const levelsOf = (update: WireRecord | undefined): number => {
	let details = (update?.partialResult as { details?: unknown } | undefined)?.details;
	let levels = 0;
	while (Array.isArray(details)) {
		expect(details).toHaveLength(1);
		details = details[0];
		levels++;
	}
	expect(details).toBe(new Date(0).toISOString());
	return levels;
};

it("senpi#5702 worker (supersedes RULING-68's isolate refusal): plain JSON and a record past the recursive engine limit are both delivered, the worker lives", async () => {
	const { records, failures, refusals, stderr } = await inWorker(
		`[[${OVER_PROTOCOL}, "leaf"], [${OVER_ENGINE}, new Date(0)]]`,
	);
	expect(failures, "the worker was not ended").toEqual([]);
	const updates = records.filter(isUpdate);
	expect(updates, "both records are delivered").toHaveLength(2);
	expect(JSON.stringify((updates[0]?.partialResult as { details?: unknown } | undefined)?.details)).toBe(
		JSON.stringify(nest(OVER_PROTOCOL)),
	);
	expect(levelsOf(updates[1])).toBe(OVER_ENGINE);
	expect(endOf(records)).toMatchObject({ isError: false });
	expect(
		records.filter((record) => record.type === "agent_idle"),
		"later records, both turns",
	).toHaveLength(2);
	expect(refusals, "nothing refused by the host writer").toBe(0);
	expect(stderr.filter((line) => REFUSED.test(line))).toEqual([]);
}, 600_000);

it("senpi#5702 worker (supersedes RULING-68's isolate refusal): a record past the isolate's recursive engine limit is delivered whole", async () => {
	const { records, failures, refusals } = await inWorker(`[[${OVER_ENGINE}, new Date(0)]]`);
	expect(failures, "the worker was not ended").toEqual([]);
	const updates = records.filter(isUpdate);
	expect(updates).toHaveLength(1);
	expect(levelsOf(updates[0])).toBe(OVER_ENGINE);
	expect(endOf(records), "the tool was not broken by the legacy writer").toMatchObject({ isError: false });
	expect(
		records.filter((record) => record.type === "agent_idle"),
		"later records, both turns",
	).toHaveLength(2);
	expect(refusals).toBe(0);
}, 600_000);
