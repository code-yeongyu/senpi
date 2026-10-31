import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { COMPACT_PROTOCOL_MAX_DEPTH } from "../../../src/modes/rpc/compact-protocol-depth.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { builtFauxPath, within, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

// Part of #4272 (S11a, RULING-68): the legacy JSONL writer keeps today's behaviour (no protocol depth limit for a legacy
// client), and its failure ABOVE the runtime's JSON engine limit is a typed refusal instead of a throw that ends the
// worker or breaks the session: the refusal is counted and reported, the session keeps running, later records arrive.

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
}, 60_000);

/** One real delivery per probe, including the refusal/reporting and two-turn survival contract. */
async function writerDelivers(depth: number): Promise<boolean> {
	const { records, refusals, stderr } = await inProcess(depth, new Date(0));
	const updates = records.filter(isUpdate);
	const delivered = updates.length === 1;
	expect(updates).toHaveLength(delivered ? 1 : 0);
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

it("RULING-105 writer-bisected depth floor, three far-depth deliveries and a typed over-engine refusal", async () => {
	// Node 26 measurements: 5888/5889 split; 4990-vs-5246 disagreed across call sites; Lw-256 refused.
	// Near-boundary replays are deliberately absent: the Node 26 delivery-path stack budget shifts by >=257
	// levels with call context. Bisection measures Lw once; P is the independent native-only probe LIMIT.
	let low = 0;
	let high = OVER_ENGINE;
	expect(await writerDelivers(high), "calibration did not find a native depth limit at the 65,536 cap").toBe(false);
	while (high - low > 1) {
		const middle = (low + high) >> 1;
		if (await writerDelivers(middle)) low = middle;
		else high = middle;
	}
	expect(low, `writer depth Lw=${low}, native probe P=${LIMIT}: early refusal below P - 512`).toBeGreaterThanOrEqual(
		LIMIT - 512,
	);
	const depth = Math.floor(Math.min(LIMIT, low) / 2);
	console.log(`RULING-105 engine Lw=${low} P=${LIMIT} far=${depth}`);
	for (let repeat = 0; repeat < 3; repeat++) expect(await writerDelivers(depth), "far depth delivered").toBe(true);
	expect(await writerDelivers(OVER_ENGINE), "over-engine refused").toBe(false);
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

it("RULING-68 worker: plain JSON is delivered unchanged; past the recursive engine limit is refused typed, the worker lives", async () => {
	const { records, failures, refusals, stderr, isolateRefusal } = await inWorker(
		`[[${OVER_PROTOCOL}, "leaf"], [${OVER_ENGINE}, new Date(0)]]`,
	);
	expect(failures, "the worker was not ended").toEqual([]);
	const updates = records.filter(isUpdate);
	expect(updates, "only the record under the engine limit is delivered").toHaveLength(1);
	expect(JSON.stringify((updates[0]?.partialResult as { details?: unknown } | undefined)?.details)).toBe(
		JSON.stringify(nest(OVER_PROTOCOL)),
	);
	expect(endOf(records)).toMatchObject({ isError: false });
	expect(
		records.filter((record) => record.type === "agent_idle"),
		"later records, both turns",
	).toHaveLength(2);
	// Exactly one writer refuses the record; an isolate refusal reaches the host only through stderr.
	if (refusals === 0) expect(REFUSED.test(await within("the isolate's refusal line", isolateRefusal))).toBe(true);
	else {
		expect(refusals, "refused by the host writer, counted once").toBe(1);
		expect(stderr.filter((line) => REFUSED.test(line))).toHaveLength(1);
	}
}, 90_000);

it("RULING-68 worker: a record past the isolate's recursive engine limit is refused typed in the isolate and reported", async () => {
	const { records, failures, isolateRefusal } = await inWorker(`[[${OVER_ENGINE}, new Date(0)]]`);
	expect(failures, "the worker was not ended").toEqual([]);
	expect(records.filter(isUpdate)).toEqual([]);
	expect(endOf(records), "the tool was not broken by the legacy writer").toMatchObject({ isError: false });
	expect(
		records.filter((record) => record.type === "agent_idle"),
		"later records, both turns",
	).toHaveLength(2);
	expect(REFUSED.test(await within("the isolate's refusal line", isolateRefusal))).toBe(true);
}, 90_000);
