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

// senpi#4557 review round 2. LOW-1: one session event deep on BOTH of its projections goes through the real binding
// and is counted exactly once (the pairing's refusal mark reaches the lane). LOW-2: a real loss ends the compact
// state, never the count, so a depth refusal after it is still sent by the isolate and counted by the host.

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
const LIMIT = COMPACT_PROTOCOL_MAX_DEPTH;
const DEPTH = 2_000;
/** Over the limit, under the depth at which an extension's `sendMessage` itself overflows the stack (2,000 on Node). */
const CUSTOM_DEPTH = 1_500;
const CUSTOM = "deep-details-4557";
const REFUSED = `senpi rpc acceptance: compact record refused: unsupported_value (depth above ${LIMIT})\n`;

type Deep = string | Deep[] | { readonly inner: Deep };

function nested(depth: number): Deep {
	let value: Deep = "leaf";
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

/** A legacy record a compact fold would serialize, as the lane's own depth check selects it. */
function serialized(record: object): boolean {
	const type = String(Reflect.get(record, "type"));
	return type === "message_end" || CALL_RECORDS.has(type) || COMPONENT_RECORDS.has(type);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

it(`runs on ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`, () => {
	expect(CUSTOM_DEPTH).toBeGreaterThan(LIMIT);
});

it("in process: an event deep on both projections through the real binding is counted exactly once", async () => {
	vi.stubEnv(FLAG, "1");
	await using host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const client = host.client("both");
	dataOf(await client.request({ type: "open_session", cwd: host.cwd }));
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	const lane = entry?.acceptance;
	const pi = [...host.extensionApis.values()].at(-1);
	if (!lane || !pi) throw new Error("no real lane or session extension API");
	// The oracle, independent of the binding's refusal mark: the structured lane emits an event's canonical record
	// just before its legacy record, so a canonical refusal belongs to the next legacy record with that carrier. The
	// message's start and end share one carrier but are two events; each refused event must count exactly once.
	const canonical = new Set<object>();
	let events = 0;
	let bothProjections = 0;
	const structured = CanonicalPairing.prototype.structured;
	vi.spyOn(CanonicalPairing.prototype, "structured").mockImplementation(function (this: CanonicalPairing, record) {
		try {
			return structured.call(this, record);
		} catch (cause) {
			const carrier = recoveryCarrier(record);
			if (carrier && protocolDepthLimitOf(cause) !== undefined) canonical.add(carrier);
			throw cause;
		}
	});
	const accept = SessionAcceptanceLane.prototype.accept;
	vi.spyOn(SessionAcceptanceLane.prototype, "accept").mockImplementation(function (
		this: SessionAcceptanceLane,
		record,
		...rest
	) {
		const carrier = recoveryCarrier(record);
		const canonicalRefused = carrier !== undefined && canonical.delete(carrier);
		const legacyRefused = serialized(record) && overLimit(record);
		if (canonicalRefused || legacyRefused) events += 1;
		if (canonicalRefused && legacyRefused) bothProjections += 1;
		return accept.call(this, record, ...rest);
	});
	const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const before = lane.storageStatus().refusedRecords;
	const delivered = client.waitFor(
		(record) =>
			record.type === "message_end" &&
			(record.message as { readonly customType?: unknown } | undefined)?.customType === CUSTOM,
	);
	await pi.sendMessage({ customType: CUSTOM, content: "deep details", display: true, details: nested(CUSTOM_DEPTH) });
	await delivered;
	await host.writer.flush();
	expect(bothProjections, "the message_end is over the limit on both projections").toBe(1);
	expect(events, "its start (canonical only) and its end").toBe(2);
	expect(lane.storageStatus().refusedRecords - before, "each refused event is counted once").toBe(events);
	expect(
		write.mock.calls.filter(([chunk]) => String(chunk) === REFUSED),
		"and reported once",
	).toHaveLength(events);
	const root = lane.freeze();
	try {
		expect(root.current, "the compact state stays available").toBeDefined();
		expect(JSON.stringify(await lane.readSettled(root))).not.toContain(CUSTOM);
	} finally {
		lane.release(root);
	}
}, 60_000);

/** Runs inside the isolate only: every seeded `text_start` fails for real, so the epoch's first loss comes first. */
const textSeedFails = `
const stringify = JSON.stringify;
JSON.stringify = function (value, ...rest) {
	const event = value !== null && typeof value === "object" ? value.assistantMessageEvent : undefined;
	if (event !== null && typeof event === "object" && event.type === "text_start" && "seed" in event)
		throw new Error("a real structured loss before the depth refusals");
	return stringify.call(this, value, ...rest);
};`;

const lossThenDeep = `(() => {
	let deep = "leaf";
	for (let level = 0; level < ${DEPTH}; level++) deep = level % 2 === 0 ? [deep] : { inner: deep };
	return [
		fauxAssistantMessage([{ type: "text", text: "before the deep call" }, fauxToolCall("deep", { value: deep })], {
			stopReason: "toolUse",
			timestamp: 1,
		}),
		answer(),
	];
})()`;

// Node only, like the real-isolate case in 4272-compact-depth-ingest.test.ts: under the Bun vitest path a real
// isolate's structured lane sends no frame at all.
it.skipIf(process.versions.bun !== undefined)(
	"worker: depth refusals after a real loss are still sent by the isolate and counted once by the host",
	async () => {
		vi.stubEnv(FLAG, "1");
		const host = await workerAcceptanceHost(builtFauxPath, textSeedFails, lossThenDeep);
		try {
			const { sessionId, worker } = await host.open();
			const lane = worker.acceptance;
			if (!lane) throw new Error("no worker lane");
			const losses: (number | undefined)[] = [];
			worker.worker.on("message", (message: SessionWorkerToHost) => {
				if (message.type === "canonical_unavailable") losses.push(message.limit);
			});
			let legacyRefusals = 0;
			const accept = SessionAcceptanceLane.prototype.accept;
			vi.spyOn(SessionAcceptanceLane.prototype, "accept").mockImplementation(function (
				this: SessionAcceptanceLane,
				record,
				carrier,
				unit,
				canonicalRefused,
			) {
				if (canonicalRefused !== true && serialized(record) && overLimit(record)) legacyRefusals += 1;
				return accept.call(this, record, carrier, unit, canonicalRefused);
			});
			vi.spyOn(process.stderr, "write").mockImplementation(() => true);
			const done = host.next("idle after the deep call", (record) => record.type === "agent_idle");
			expect((await host.request({ type: "prompt", sessionId, message: "go deep" })).success).toBe(true);
			await done;
			await host.writer.flush();
			expect(losses[0], "the epoch's real loss comes first").toBeUndefined();
			expect(
				losses.filter((limit) => limit === undefined),
				"exactly one real loss is sent",
			).toHaveLength(1);
			const refusals = losses.filter((limit) => limit === LIMIT).length;
			expect(refusals, "depth refusals are still sent after the real loss").toBeGreaterThan(0);
			expect(host.failures).toEqual([]);
			expect(lane.storageStatus().refusedRecords, "each refused record counted once").toBe(
				refusals + legacyRefusals,
			);
			const root = lane.freeze();
			try {
				expect(root.current, "the real loss ended the epoch's compact state").toBeUndefined();
			} finally {
				lane.release(root);
			}
		} finally {
			await host.dispose();
		}
	},
	90_000,
);
