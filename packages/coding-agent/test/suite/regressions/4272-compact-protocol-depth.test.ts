import { afterEach, expect, it, vi } from "vitest";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import { CanonicalPairing } from "../../../src/modes/rpc/compact-canonical-pairing.ts";
import { CompactWriteError } from "../../../src/modes/rpc/compact-content-store.ts";
import { COMPACT_PROTOCOL_MAX_DEPTH } from "../../../src/modes/rpc/compact-protocol-depth.ts";
import { announced, type CallsRig, callsRig } from "./4272-calls-support.ts";

// senpi#4272 RULING-59 C: one protocol depth limit at the compact ingest boundary. A record one level under it is
// owned and round-trips; one level over it is refused with a typed CompactWriteError carrying the limit, before the
// JSON clone, and the session's compact state stays available with the refusal counted and reported.

const LIMIT = COMPACT_PROTOCOL_MAX_DEPTH;
/** Far above Node's native JSON limit and Bun's (40,000): the clone would throw an untyped RangeError. */
const ENGINE_BREAKING = 50_000;

function nested(depth: number): unknown {
	let value: unknown = "leaf";
	for (let level = 0; level < depth; level++) value = level % 2 === 0 ? [value] : { inner: value };
	return value;
}

/** A lifecycle record whose total depth is `depth`: the record object is the first level. */
const lifecycle = (depth: number) => ({ type: "session_lifecycle", sessionId: "s", lifecycle: nested(depth - 1) });

function refusal(run: () => unknown): unknown {
	try {
		run();
	} catch (cause) {
		return cause;
	}
	return undefined;
}

function reports() {
	const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	return () => write.mock.calls.map(([chunk]) => String(chunk)).filter((line) => line.includes("compact"));
}

async function available(rig: CallsRig) {
	const root = rig.lane.freeze();
	try {
		expect(root.current, "the session's compact state stays available").toBeDefined();
		return { components: await rig.lane.readCurrentComponents(root), calls: await rig.lane.readCurrentCalls(root) };
	} finally {
		rig.lane.release(root);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

it(`runs on ${process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.version}`}`, () => {
	expect(LIMIT).toBeLessThan(6_185);
});

it("a component record one level under the limit is owned and round-trips", async () => {
	const rig = await callsRig();
	try {
		const record = lifecycle(LIMIT - 1);
		rig.record(record);
		const { components } = await available(rig);
		expect(JSON.stringify(components.lifecycle)).toBe(JSON.stringify(record));
		expect(rig.lane.storageStatus().refusedRecords).toBe(0);
	} finally {
		await rig.close();
	}
});

it.each([LIMIT + 1, ENGINE_BREAKING])("a component record %i deep is refused and the state stays", async (depth) => {
	const rig = await callsRig();
	const lines = reports();
	try {
		const kept = lifecycle(3);
		rig.record(kept);
		rig.record(lifecycle(depth));
		const { components } = await available(rig);
		expect(components.lifecycle, "the refused record changed nothing").toEqual(kept);
		expect(rig.lane.storageStatus().refusedRecords).toBe(1);
		expect(lines()).toEqual([
			`senpi rpc acceptance: compact record refused: unsupported_value (depth above ${LIMIT})\n`,
		]);
	} finally {
		await rig.close();
	}
});

it("a call record over the limit is refused and the calls component keeps its last value", async () => {
	const rig = await callsRig();
	const lines = reports();
	try {
		await announced(rig, "c1");
		const execution = { toolCallId: "c1", toolName: "bash", args: { command: "c1" } };
		rig.record({ type: "tool_execution_start", ...execution });
		const progress = (depth: number) => ({
			type: "tool_execution_update",
			...execution,
			partialResult: nested(depth),
		});
		const under = progress(LIMIT - 2);
		rig.record(under);
		expect(JSON.stringify((await available(rig)).calls.calls[0]?.progress)).toBe(JSON.stringify(under.partialResult));
		rig.record(progress(LIMIT));
		rig.record(progress(ENGINE_BREAKING));
		const { calls } = await available(rig);
		expect(JSON.stringify(calls.calls[0]?.progress)).toBe(JSON.stringify(under.partialResult));
		expect(rig.lane.storageStatus().refusedRecords).toBe(2);
		expect(lines()).toHaveLength(2);
	} finally {
		await rig.close();
	}
});

// senpi#4557 review MEDIUM and LOW-4: the settled terminal is serialized from the incoming message_end, so the
// protocol check refuses that record before it, typed and counted, and nothing of it reaches the settled terminals;
// above the engine limit the lane throws no RangeError.
it.each([2_000, ENGINE_BREAKING])(
	"a toolResult message_end %i deep never reaches the settled terminals",
	async (depth) => {
		const rig = await callsRig();
		const lines = reports();
		try {
			const kept = rig.toolResult("c0", "bash", "kept");
			const record = {
				type: "message_end",
				message: {
					role: "toolResult",
					toolCallId: "c1",
					toolName: "bash",
					content: nested(depth - 2),
					timestamp: 1,
				},
			};
			rig.producer.observe(record);
			const carrier = recoveryCarrier(record);
			if (!carrier) throw new Error("producer failed to mint");
			expect(
				refusal(() => rig.lane.accept(record, carrier)),
				"no untyped RangeError out of the lane",
			).toBeUndefined();
			await available(rig);
			const root = rig.lane.freeze();
			try {
				const ids = (await rig.lane.readSettled(root)).settledMessages.map((message) => message.messageId);
				expect(ids).toEqual([kept.messageId]);
			} finally {
				rig.lane.release(root);
			}
			expect(rig.lane.storageStatus().refusedRecords, "one event, one refusal").toBe(1);
			expect(lines()).toEqual([
				`senpi rpc acceptance: compact record refused: unsupported_value (depth above ${LIMIT})\n`,
			]);
		} finally {
			await rig.close();
		}
	},
);

it("a canonical record over the limit is refused typed at the pairing, and the lane keeps its state", async () => {
	const rig = await callsRig();
	const lines = reports();
	try {
		const pairing = new CanonicalPairing();
		const canonical = (depth: number) => {
			const record = { type: "message_start", message: { role: "assistant", content: nested(depth - 2) } };
			rig.producer.observe(record);
			return record;
		};
		const under = canonical(LIMIT - 1);
		expect(pairing.structured(under)).toBeUndefined();
		expect(JSON.stringify(pairing.take(under))).toBe(JSON.stringify(under));
		for (const depth of [LIMIT + 1, ENGINE_BREAKING]) {
			const over = canonical(depth);
			expect(recoveryCarrier(over)).toBeDefined();
			const cause = refusal(() => pairing.structured(over));
			expect(cause).toBeInstanceOf(CompactWriteError);
			expect(cause).toMatchObject({ reason: "unsupported_value", limit: LIMIT });
			expect(pairing.take(over), "nothing pairs with the refused record").toBeUndefined();
			rig.lane.compactUnavailable(cause);
		}
		await available(rig);
		expect(rig.lane.storageStatus().refusedRecords).toBe(2);
		expect(lines()).toHaveLength(2);
		rig.lane.compactUnavailable(new Error("lost"));
		const root = rig.lane.freeze();
		expect(root.current, "any other loss still ends the epoch's compact state").toBeUndefined();
		rig.lane.release(root);
	} finally {
		await rig.close();
	}
});
