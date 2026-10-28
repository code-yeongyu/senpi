import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { MEDIA_PLACEHOLDERS_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import { enqueueLegacyRecord } from "../../../src/modes/rpc/legacy-record-depth.ts";
import { omitNormalInlineMedia } from "../../../src/modes/rpc/media-placeholders.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { goldenOf } from "./4272-legacy-media-golden-support.ts";
import { builtFauxPath, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

// Part of #4272 (S11a, RULING-68, review LOW 3): a client that advertises media placeholders gets today's legacy
// behaviour too. A record under the JSON engine limit reaches it unchanged (the media walk once overflowed the stack
// from about 3,000 levels on Node and ended the worker); past the engine limit it is the typed, counted refusal.

type Deep = string | Deep[];
const nest = (depth: number): Deep => {
	let value: Deep = "leaf";
	for (let level = 0; level < depth; level++) value = [value];
	return value;
};
const serializes = (depth: number): boolean => {
	try {
		JSON.stringify(nest(depth));
		return true;
	} catch {
		return false;
	}
};
function engineLimit(): number {
	let low = 1;
	let high = 2;
	while (serializes(high)) [low, high] = [high, high * 2];
	while (high - low > 1) {
		const middle = (low + high) >> 1;
		if (serializes(middle)) low = middle;
		else high = middle;
	}
	return low;
}
const LIMIT = engineLimit();
const DEEP = 4_000;
const PNG = "aGVsbG8gd29ybGQh";
const REFUSED =
	/^senpi rpc host: legacy record refused: tool_execution_end nests deeper than this runtime's JSON engine limit \(session [^)]+\)\n$/;

const content = () => [
	{ type: "text" as const, text: "returned" },
	{ type: "image" as const, data: PNG, mimeType: "image/png" },
];
const deepToolEnd = (depth: number) => ({
	type: "tool_execution_end",
	toolCallId: "call_deep",
	toolName: "deep_result",
	result: { content: content(), details: nest(depth) },
	isError: false,
});
const detailsOf = (record: WireRecord | undefined) => (record?.result as { details?: unknown } | undefined)?.details;
const blockOf = (record: WireRecord | undefined) =>
	(record?.result as { content?: unknown[] } | undefined)?.content?.[1];
const isDeepEnd = (record: WireRecord) => record.type === "tool_execution_end" && record.toolName === "deep_result";

afterEach(() => {
	vi.restoreAllMocks();
});

it(`runs on ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`} (engine limit ${LIMIT})`, () => {
	expect(DEEP, "the 4,000-level record is under the engine limit").toBeLessThan(LIMIT);
});

it("ordinary records with placeholders keep the recursive walk's exact output, identity and persister calls (golden)", () => {
	const golden = readFileSync(new URL("./4272-legacy-media-golden.json", import.meta.url), "utf8");
	expect(`${JSON.stringify(goldenOf(omitNormalInlineMedia), null, "\t")}\n`).toBe(golden);
});

it.each([DEEP, LIMIT])("the media walk passes a %i-deep record through, its deep subtree by reference", (depth) => {
	const record = deepToolEnd(depth);
	const redacted = omitNormalInlineMedia(record);
	expect(redacted.result.content[1]).toMatchObject({ type: "image_ref", ref: { toolCallId: "call_deep" } });
	expect(redacted.result.details).toBe(record.result.details);
});

it.each([DEEP, LIMIT - 8])("the media walk reaches a toolResult buried %i levels deep", (depth) => {
	let messages: unknown = { role: "toolResult", toolCallId: "buried", content: content() };
	for (let level = 0; level < depth; level++) messages = [messages];
	const redacted = omitNormalInlineMedia({ type: "agent_end", messages });
	let found: unknown = redacted.messages;
	while (Array.isArray(found)) found = found[0];
	expect((found as { content: unknown[] }).content[1]).toMatchObject({
		type: "image_ref",
		ref: { toolCallId: "buried" },
	});
});

async function inProcess(run: (host: Awaited<ReturnType<typeof statusHost>>, sessionId: string) => void, depth = 0) {
	await using host = await statusHost();
	const client = host.client("capable");
	host.writer.setConnectionCapabilities("capable", [MEDIA_PLACEHOLDERS_CAPABILITY]);
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const pi = [...host.extensionApis.values()].at(-1);
	if (!pi) throw new Error("no session extension API");
	pi.registerTool({
		name: "deep_result",
		label: "Deep result",
		description: "Returns an image and deep details.",
		parameters: Type.Object({}),
		execute: async () => ({ content: content(), details: nest(depth) }),
	});
	host.faux.setResponses([
		...(depth > 0 ? [fauxAssistantMessage(fauxToolCall("deep_result", {}), { stopReason: "toolUse" })] : []),
		fauxAssistantMessage("first answer"),
		fauxAssistantMessage("the session keeps running"),
	]);
	const stderr: string[] = [];
	vi.spyOn(process.stderr, "write").mockImplementation((chunk) => stderr.push(String(chunk)) > 0);
	run(host, sessionId);
	const ends = () => client.inbox.filter((record) => record.type === "agent_end").length;
	for (const [message, count] of [
		["go", 1],
		["again", 2],
	] as const) {
		const ended = client.waitFor((record) => record.type === "agent_end" && ends() === count);
		expect((await client.request({ type: "prompt", sessionId, message })).success).toBe(true);
		await ended;
	}
	await host.writer.flush();
	return { records: [...client.inbox], refusals: host.writer.legacyRefusals.count, stderr };
}

it("in process: a media-placeholder client receives a 4,000-deep tool result unchanged, its image as image_ref", async () => {
	const { records, refusals, stderr } = await inProcess(() => {}, DEEP);
	const end = records.find(isDeepEnd);
	expect(blockOf(end)).toMatchObject({ type: "image_ref", ref: { toolCallId: expect.any(String), contentIndex: 1 } });
	expect(JSON.stringify(detailsOf(end))).toBe(JSON.stringify(nest(DEEP)));
	expect(refusals).toBe(0);
	expect(stderr.filter((line) => line.startsWith("senpi rpc host: legacy record refused"))).toEqual([]);
	expect(records.filter((record) => record.type === "agent_end")).toHaveLength(2);
}, 90_000);

it("in process: past the engine limit with placeholders on, the record is a typed counted refusal; the session runs on", async () => {
	let accepted: boolean | undefined;
	const { records, refusals, stderr } = await inProcess((host, sessionId) => {
		accepted = enqueueLegacyRecord(host.writer, sessionId, deepToolEnd(LIMIT + 1));
	});
	expect(accepted, "consumed, not an overflow or a closed session").toBe(true);
	expect(records.filter(isDeepEnd)).toEqual([]);
	expect(refusals, "counted once").toBe(1);
	expect(
		stderr.filter((line) => REFUSED.test(line)),
		"reported once",
	).toHaveLength(1);
	expect(
		records.filter((record) => record.type === "agent_end"),
		"later records, both turns",
	).toHaveLength(2);
}, 90_000);

const isolatePrelude = `
const nest = (depth) => { let value = "leaf"; for (let level = 0; level < depth; level++) value = [value]; return value; };`;
const deepResultTool = (depth: number) => `(() => {
	pi.registerTool({
		name: "deep_result",
		label: "Deep result",
		description: "Returns an image and deep details.",
		parameters: { type: "object", properties: {} },
		execute: async () => ({
			content: [{ type: "text", text: "returned" }, { type: "image", data: ${JSON.stringify(PNG)}, mimeType: "image/png" }],
			details: nest(${depth}),
		}),
	});
	return [fauxAssistantMessage([fauxToolCall("deep_result", {})], { stopReason: "toolUse", timestamp: 1 }), answer(), answer()];
})()`;

it.each([DEEP, LIMIT - 256])(
	"worker: a media-placeholder client receives a %i-deep tool result unchanged and the worker lives",
	async (depth) => {
		const host = await workerAcceptanceHost(builtFauxPath, isolatePrelude, deepResultTool(depth));
		try {
			host.writer.setConnectionCapabilities("c", [MEDIA_PLACEHOLDERS_CAPABILITY]);
			const { sessionId } = await host.open();
			for (const message of ["go deep", "again"]) {
				// A hang guard, not a timing assertion: a record near the engine limit is serialized and parsed several times
				// (isolate, host, writer), which on Bun at ~40,000 levels under a loaded host takes longer than the default 30 s.
				const idle = host.next(`idle after ${message}`, (record) => record.type === "agent_idle", 120_000);
				expect((await host.request({ type: "prompt", sessionId, message })).success).toBe(true);
				await idle;
			}
			await host.writer.flush();
			expect(host.failures, "the worker was not ended").toEqual([]);
			const end = host.records.find(isDeepEnd);
			expect(blockOf(end)).toMatchObject({ type: "image_ref", ref: { contentIndex: 1 } });
			expect(JSON.stringify(detailsOf(end))).toBe(JSON.stringify(nest(depth)));
			expect(host.writer.legacyRefusals.count).toBe(0);
			expect(host.records.filter((record) => record.type === "agent_idle")).toHaveLength(2);
		} finally {
			await host.dispose();
		}
	},
	300_000,
);
