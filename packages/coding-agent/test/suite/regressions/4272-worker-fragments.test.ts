import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { CompactLaneCurrent } from "../../../src/modes/rpc/compact-lane-current.ts";
import { FRAGMENT_MAX_BYTES } from "../../../src/modes/rpc/compact-recovery-bytes.ts";
import type { SessionWorkerToHost } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { expectOneNumbering, recordFolds } from "./4272-compact-lane-support.ts";
import {
	builtFauxPath,
	creditOf,
	type OutputFrame,
	within,
	workerAcceptanceHost,
} from "./4272-worker-acceptance-support.ts";

const FLAG = "SENPI_ENGINE_SOCKET_COMPACT_UPDATES";
/** Code units one fragment carries: D stored bytes, two per UTF-16 code unit. */
const UNITS = FRAGMENT_MAX_BYTES / 2;
/** A prompt several fragments long (and inside the faux context window): its user message records cannot cross in one frame. */
const PROMPT = "a word ".repeat(21_000);

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

type Posted = SessionWorkerToHost & { readonly [key: string]: unknown };
interface Fragment {
	readonly type: "fragment";
	readonly of: string;
	readonly length: number;
	readonly offset: number;
	readonly text: string;
	readonly ordinal?: number;
	readonly firstOrdinal?: number;
	readonly signal?: SharedArrayBuffer;
}

const isFragment = (message: Posted): message is Posted & Fragment => message.type === "fragment";
const isFinal = (fragment: Fragment) => fragment.offset + fragment.text.length * 2 === fragment.length;
const textOf = (record: Record<string, unknown> | undefined): unknown =>
	Reflect.get(Object(Reflect.get(Object(record?.message), "content")?.[0]), "text");

/**
 * A payload message as the worker transport fragments it: its JSON without the signal, cut into pieces of at most D
 * stored bytes that take consecutive ordinals from `first`; the final piece is the commit frame with the binding.
 */
function fragmentsOf(message: OutputFrame, first: number, firstOrdinal: number | undefined): Fragment[] {
	const { signal, ordinal: _ordinal, firstOrdinal: _first, ...payload } = message;
	const text = JSON.stringify(payload);
	const count = Math.ceil(text.length / UNITS);
	return Array.from({ length: count }, (_unused, index) => ({
		type: "fragment",
		of: message.type,
		length: text.length * 2,
		offset: index * UNITS * 2,
		text: text.slice(index * UNITS, (index + 1) * UNITS),
		ordinal: first + index,
		...(index === count - 1 ? { signal, ...(firstOrdinal === undefined ? {} : { firstOrdinal }) } : {}),
	}));
}

/** One real worker session that ran one prompt, with every message its isolate posted from the open onwards. */
async function promptedWorker(message = "go") {
	const host = await workerAcceptanceHost(builtFauxPath);
	const { sessionId, worker } = await host.open();
	const posted: Posted[] = [];
	worker.worker.on("message", (each: Posted) => posted.push(each));
	const done = host.next("idle", (record) => record.type === "agent_idle");
	expect((await host.request({ type: "prompt", sessionId, message })).success).toBe(true);
	await done;
	await host.writer.flush();
	return { host, worker, posted, lane: worker.acceptance };
}

// Part of #4272, S12 design T6 X04 + RULING-64 (1) (2): through the REAL worker, oversized records cross in bounded
// fragments that share the one physical ordinal sequence; only the final commit frame's ordinal is the record's.
it("S12b T6 X04 RULING-64 (1)(2): a 150 KB prompt crosses the real worker as bounded fragments, folded at its final commit-frame ordinals", async () => {
	vi.stubEnv(FLAG, "1");
	const folds = recordFolds();
	const { host, posted, lane } = await promptedWorker(PROMPT);
	try {
		if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
		const fragments = posted.filter(isFragment);
		expect(fragments.length, "records over one fragment travel as fragments").toBeGreaterThan(2);
		for (const fragment of fragments) expect(fragment.text.length * 2).toBeLessThanOrEqual(FRAGMENT_MAX_BYTES);
		const ordinals = posted.flatMap((each) => (typeof each.ordinal === "number" ? [each.ordinal] : []));
		expect(ordinals, "one physical ordinal sequence, fragments included").toEqual(
			ordinals.map((_ordinal, index) => (ordinals[0] ?? 0) + index),
		);
		const finals = fragments
			.filter((each) => isFinal(each) && each.ordinal !== undefined)
			.map((each) => each.ordinal);
		const prefixes = fragments.filter((each) => !isFinal(each)).map((each) => each.ordinal);
		expect(prefixes.length).toBeGreaterThan(0);
		expect(
			folds.filter(({ t }) => prefixes.includes(t.ordinal)),
			"a fragment prefix never folds",
		).toEqual([]);
		const user = folds.filter(
			({ t }) => t.type === "seeded_message" && Reflect.get(t.record, "message")?.role === "user",
		);
		expect(user.length, "the user message's start and end both folded").toBeGreaterThanOrEqual(2);
		const [start, ...later] = user;
		expect(finals, "(1) the fragmented first start folds at its final commit-frame ordinal").toContain(
			start?.t.ordinal,
		);
		expect(start?.t.firstOrdinal, "(1) its binding is that commit ordinal").toBe(start?.t.ordinal);
		for (const fold of later) {
			expect(finals, "(2) a later record of the same message is a fragmented commit too").toContain(fold.t.ordinal);
			expect(fold.t.firstOrdinal, "(2) it presents the same bound first ordinal").toBe(start?.t.ordinal);
		}
		expectOneNumbering(folds, lane.recoveryEpoch);
		const end = host.records.find((record) => record.type === "message_end" && textOf(record) === PROMPT);
		expect(end, "the legacy reader receives the whole user message").toBeDefined();
		expect(lane.storageStatus().transcript.openTransfers).toBe(0);
		expect(host.failures).toEqual([]);
	} finally {
		await host.dispose();
	}
}, 120_000);

/** The output frame that carried the first block start of the run's assistant message. */
function assistantStart(posted: readonly Posted[]): OutputFrame {
	const frame = posted.find(
		(each): each is Posted & OutputFrame =>
			each.type === "output" &&
			Reflect.get(Object(Reflect.get(Object(each.canonical), "assistantMessageEvent")), "type") === "text_start",
	);
	if (!frame) throw new Error("the run produced no assistant text start");
	return frame;
}

// RULING-64 (3) + RULING-40: a stale duplicate start, fragmented, reaches the start identity at its commit ordinal and
// is rejected exactly; its fragment prefixes never move the high-water.
it("S12b RULING-64 (3): a fragmented stale duplicate block start is rejected with exactly duplicate_or_stale_start", async () => {
	vi.stubEnv(FLAG, "1");
	const { host, worker, posted, lane } = await promptedWorker();
	try {
		const intake = worker.intake;
		if (!lane || !intake) throw new Error("flag on: the worker client owns a lane and an intake");
		const original = assistantStart(posted);
		const causes: unknown[] = [];
		const fail = CompactLaneCurrent.prototype.fail;
		vi.spyOn(CompactLaneCurrent.prototype, "fail").mockImplementation(function (this: CompactLaneCurrent, cause) {
			causes.push(cause);
			return fail.call(this, cause);
		});
		const duplicate: OutputFrame = {
			...original,
			record: { ...original.record, padding: "x".repeat(300_000) },
			signal: new SharedArrayBuffer(4),
		};
		const fragments = fragmentsOf(duplicate, intake.nextOrdinal, original.firstOrdinal);
		expect(fragments.length).toBeGreaterThan(1);
		for (const fragment of fragments) worker.worker.emit("message", fragment);
		expect(await within("commit credit", creditOf(duplicate.signal)), "legacy delivery is unaffected").toBe(1);
		expect(causes).toEqual([expect.objectContaining({ reason: "duplicate_or_stale_start" })]);
		expect(intake.nextOrdinal, "every physical frame took its ordinal").toBe((fragments.at(-1)?.ordinal ?? 0) + 1);
		expect(host.failures).toEqual([]);
	} finally {
		await host.dispose();
	}
}, 120_000);

// RULING-64 (4) + RULING-39: a producer restarting its counter inside the same epoch is a typed reject, never accepted.
it("S12b RULING-64 (4): a same-epoch reset (a fragment restarting the ordinal counter) is rejected typed and accepts nothing", async () => {
	vi.stubEnv(FLAG, "1");
	const { host, worker, posted, lane } = await promptedWorker();
	try {
		if (!lane) throw new Error("flag on: the worker client owns an acceptance lane");
		const before = lane.freeze();
		lane.release(before);
		const original = assistantStart(posted);
		const [reset] = fragmentsOf({ ...original, record: { ...original.record, padding: "x".repeat(300_000) } }, 0, 0);
		if (!reset) throw new Error("no fragment");
		worker.worker.emit("message", reset);
		await within("worker incarnation exits", worker.exited);
		expect(host.failures).toEqual(["session_worker_frame_duplicate"]);
		expect(lane.retired).toBe(true);
		const after = lane.freeze();
		expect(after.sequence, "nothing was accepted").toBe(before.sequence);
		expect(lane.storageStatus().transcript.openTransfers, "nothing was left staged").toBe(0);
	} finally {
		await host.dispose();
	}
}, 120_000);

// S12 design T5 X04: a gap or duplicate inside a transfer, or a worker ending mid-transfer, fails typed, accepts nothing
// and releases what the transfer staged exactly once.
it.each([
	["gap", (fragments: Fragment[]) => [fragments[0], { ...fragments[1], offset: (fragments[1]?.offset ?? 0) + 2 }]],
	["duplicate", (fragments: Fragment[]) => [fragments[0], { ...fragments[0], ordinal: fragments[1]?.ordinal }]],
	["cancel", (fragments: Fragment[]) => [fragments[0]]],
] as const)(
	"S12b T5 X04 %s: a broken or cancelled transfer accepts nothing and leaves nothing staged",
	async (kind, pick) => {
		vi.stubEnv(FLAG, "1");
		const { host, worker, posted, lane } = await promptedWorker();
		try {
			const intake = worker.intake;
			if (!lane || !intake) throw new Error("flag on: the worker client owns a lane and an intake");
			const staged = lane.storageStatus().transcript.stagedBytes;
			const before = lane.freeze();
			lane.release(before);
			const original = assistantStart(posted);
			const padded = { ...original, record: { ...original.record, padding: "x".repeat(300_000) } };
			for (const fragment of pick(fragmentsOf(padded, intake.nextOrdinal, original.firstOrdinal)))
				worker.worker.emit("message", fragment);
			if (kind === "cancel") {
				expect(lane.storageStatus().transcript.openTransfers, "the first fragment is staged").toBe(1);
				worker.quarantine();
			}
			await within("worker incarnation exits", worker.exited);
			expect(host.failures).toEqual(kind === "cancel" ? [] : [`session_worker_frame_${kind}`]);
			expect(lane.freeze().sequence, "nothing was accepted").toBe(before.sequence);
			expect(lane.storageStatus().transcript).toMatchObject({ openTransfers: 0, stagedBytes: staged });
		} finally {
			await host.dispose();
		}
	},
	120_000,
);

// Golden: with the flag OFF, the worker transport and bytes are exactly the legacy ones.
it("S12b golden: flag OFF, no permit block and no fragment; the 150 KB record crosses as one structured output frame", async () => {
	const sent = vi.spyOn(Worker.prototype, "postMessage");
	const { host, worker, posted } = await promptedWorker(PROMPT);
	try {
		expect(worker.intake).toBeUndefined();
		const commit = sent.mock.calls.map(([message]) => message).find((message) => message?.type === "commit");
		expect(commit).toEqual({ type: "commit", request: expect.any(Number) });
		expect(posted.some((each) => each.type === "fragment")).toBe(false);
		const start = posted.find(
			(each) => each.type === "output" && textOf(Object(Reflect.get(each, "record"))) === PROMPT,
		);
		expect(start, "the whole record in one frame").toMatchObject({
			type: "output",
			record: { type: "message_start" },
		});
		expect(start).not.toHaveProperty("ordinal");
		expect(host.records.find((record) => record.type === "message_end" && textOf(record) === PROMPT)).toBeDefined();
		expect(host.failures).toEqual([]);
	} finally {
		await host.dispose();
	}
}, 120_000);
