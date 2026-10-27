import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { CALL_RECORDS } from "../../../src/modes/rpc/compact-call-model.ts";
import { CanonicalPairing } from "../../../src/modes/rpc/compact-canonical-pairing.ts";
import { COMPONENT_RECORDS } from "../../../src/modes/rpc/compact-current-components.ts";
import {
	assertProtocolDepth,
	COMPACT_PROTOCOL_MAX_DEPTH,
	protocolDepthLimitOf,
} from "../../../src/modes/rpc/compact-protocol-depth.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { type RpcSessionEntry, RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import type { SessionWorkerToHost } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { dataOf, statusHost } from "../rpc-session-status-support.ts";
import { builtFauxPath, workerAcceptanceHost } from "./4272-worker-acceptance-support.ts";

// senpi#4557 review LOW-2 and LOW-3: a model's tool call nested 2,000 deep goes through the real ingest (the
// structured lane, the pairing, the binding or the isolate's frame writer, the acceptance lane). Each session event
// it reaches is refused at the protocol depth limit once, whichever of its two projections the limit stopped first,
// none of it reaches the compact state, the state stays available and every legacy record is still delivered.

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const LIMIT = COMPACT_PROTOCOL_MAX_DEPTH;
const DEPTH = 2_000;
const MARK = "deep-leaf-4557";
const REFUSED = `senpi rpc acceptance: compact record refused: unsupported_value (depth above ${LIMIT})\n`;
const ANSWER = "answer after the deep call";

type Deep = string | Deep[] | { readonly inner: Deep };

function nested(depth: number): Deep {
	let value: Deep = MARK;
	for (let level = 0; level < depth; level++) value = level % 2 === 0 ? [value] : { inner: value };
	return value;
}

function overLimit(record: object): boolean {
	try {
		assertProtocolDepth(record);
		return false;
	} catch (cause) {
		return protocolDepthLimitOf(cause) !== undefined;
	}
}

/**
 * The session events the protocol limit stopped, by event identity (its recovery carrier, which both of its projections
 * share in process; a carrier-less record is its own identity): one whose canonical projection the pairing refused, or
 * whose legacy record a compact fold would serialize (a call or component record, a terminal) and is too deep.
 */
function refusedEvents() {
	const events = new Set<object>();
	const structured = CanonicalPairing.prototype.structured;
	vi.spyOn(CanonicalPairing.prototype, "structured").mockImplementation(function (this: CanonicalPairing, record) {
		try {
			return structured.call(this, record);
		} catch (cause) {
			if (protocolDepthLimitOf(cause) !== undefined) events.add(recoveryCarrier(record) ?? record);
			throw cause;
		}
	});
	const accept = SessionAcceptanceLane.prototype.accept;
	vi.spyOn(SessionAcceptanceLane.prototype, "accept").mockImplementation(function (
		this: SessionAcceptanceLane,
		record,
		...rest
	) {
		const type = String(Reflect.get(record, "type"));
		const serialized = type === "message_end" || CALL_RECORDS.has(type) || COMPONENT_RECORDS.has(type);
		if (serialized && overLimit(record)) events.add(recoveryCarrier(record) ?? record);
		return accept.call(this, record, ...rest);
	});
	return events;
}

function refusalLines() {
	const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return () => write.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line === REFUSED);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it(`runs on ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`, () => {
	expect(DEPTH).toBeGreaterThan(LIMIT);
});

it("in process: a deep tool call is refused once per event through the real ingest and the state stays", async () => {
	vi.stubEnv(FLAG, "1");
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("deep");
	const sessionId = String(dataOf(await client.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	if (!lane) throw new Error("no real lane");
	const lines = refusalLines();
	const events = refusedEvents();
	host.faux.setResponses([
		fauxAssistantMessage([fauxToolCall("deep", { value: nested(DEPTH) })], { stopReason: "toolUse", timestamp: 1 }),
		fauxAssistantMessage(ANSWER, { timestamp: 1 }),
	]);
	const done = client.waitFor((record) => record.type === "agent_idle", 15_000);
	dataOf(await client.request({ type: "prompt", sessionId, message: "go deep" }));
	await done;
	await host.writer.flush();
	const delivered = JSON.stringify(client.inbox);
	expect(delivered, "the deep legacy records were delivered").toContain(MARK);
	expect(delivered).toContain(ANSWER);
	expect(events.size).toBeGreaterThan(0);
	expect(lane.storageStatus().refusedRecords, "one count per refused event").toBe(events.size);
	expect(lines(), "each refusal reported once").toHaveLength(events.size);
	const root = lane.freeze();
	try {
		expect(root.current, "the compact state stays available").toBeDefined();
		const settled = JSON.stringify(await lane.readSettled(root));
		expect(settled, "no refused record reached a settled terminal").not.toContain(MARK);
		expect(overLimit(await lane.readCurrent(root)), "no refused value reached the current state").toBe(false);
	} finally {
		lane.release(root);
	}
}, 60_000);

/** Runs inside the isolate only: the structured lane's seeded `text_start` (the answer after the call) is a real loss. */
const answerSeedFails = `
const stringify = JSON.stringify;
JSON.stringify = function (value, ...rest) {
	const event = value !== null && typeof value === "object" ? value.assistantMessageEvent : undefined;
	if (event !== null && typeof event === "object" && event.type === "text_start" && "seed" in event)
		throw new Error("a real structured loss after the depth refusals");
	return stringify.call(this, value, ...rest);
};`;

const deepThenAnswer = `(() => {
	let deep = ${JSON.stringify(MARK)};
	for (let level = 0; level < ${DEPTH}; level++) deep = level % 2 === 0 ? [deep] : { inner: deep };
	return [
		fauxAssistantMessage([fauxToolCall("deep", { value: deep })], { stopReason: "toolUse", timestamp: 1 }),
		fauxAssistantMessage(${JSON.stringify(ANSWER)}, { timestamp: 1 }),
	];
})()`;

// The isolate's frame writer sends a depth refusal with its limit and keeps sending (session-worker.ts
// `canonicalLost = limit === undefined`), so a later real loss in the same epoch still reaches the host and ends it.
// Node only: under the Bun vitest path a real isolate's structured lane sends no frame at all, which
// 4272-worker-structured-failure.test.ts shows the same way; the depth refusal itself runs on both runtimes above
// and in 4272-compact-fold-failure.test.ts.
it.skipIf(process.versions.bun !== undefined)(
	"worker: depth refusals in a real isolate keep the state until a later real loss ends it",
	async () => {
		vi.stubEnv(FLAG, "1");
		const host = await workerAcceptanceHost(builtFauxPath, answerSeedFails, deepThenAnswer);
		try {
			const { sessionId, worker } = await host.open();
			const lane = worker.acceptance;
			if (!lane) throw new Error("no worker lane");
			const losses: { readonly limit: number | undefined; readonly reason: string }[] = [];
			worker.worker.on("message", (message: SessionWorkerToHost) => {
				if (message.type === "canonical_unavailable") losses.push({ limit: message.limit, reason: message.reason });
			});
			const done = host.next("idle after the deep call", (record) => record.type === "agent_idle");
			expect((await host.request({ type: "prompt", sessionId, message: "go deep" })).success).toBe(true);
			await done;
			await host.writer.flush();
			const real = losses.flatMap((loss, index) => (loss.limit === undefined ? [index] : []));
			expect(losses.filter((loss) => loss.limit === LIMIT).length).toBeGreaterThan(0);
			expect(real, "exactly one real loss is sent, after the depth refusals").toEqual([losses.length - 1]);
			expect(losses.at(-1)?.reason).toBe("a real structured loss after the depth refusals");
			const delivered = JSON.stringify(host.records);
			expect(delivered).toContain(MARK);
			expect(delivered).toContain(ANSWER);
			expect(host.failures).toEqual([]);
			expect(lane.retired).toBe(false);
			expect(lane.storageStatus().refusedRecords).toBeGreaterThan(0);
			const root = lane.freeze();
			try {
				expect(root.current, "the real loss ended the epoch's compact state").toBeUndefined();
				expect(JSON.stringify(await lane.readSettled(root))).not.toContain(MARK);
			} finally {
				lane.release(root);
			}
		} finally {
			await host.dispose();
		}
	},
	90_000,
);
