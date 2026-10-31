import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, ToolChildCodecError } from "./codec.ts";
import { PayloadRefError, PayloadRefReader, PayloadRefWriter } from "./payload-ref.ts";
import { refFilePath, spoolDir, sweepRefGenerations, teardownRefGeneration } from "./payload-ref-paths.ts";
import { packPayload, unpackPayload } from "./payload-wire.ts";
import { type PayloadRef, type RefControl, TOOL_CHILD_LIMITS, type ToolChildMessage } from "./protocol.ts";

const MIB = 1024 * 1024;
let root = "";

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "senpi-tool-child-refs-"));
});
afterEach(async () => {
	await rm(root, { recursive: true, force: true });
});

const exists = (path: string): Promise<boolean> =>
	access(path).then(
		() => true,
		() => false,
	);

function deferred() {
	let resolve = (): void => undefined;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function bytesOf(size: number, seed = 7): Uint8Array {
	const bytes = new Uint8Array(size);
	for (let index = 0; index < size; index += 1) bytes[index] = (index * 31 + seed) & 0xff;
	return bytes;
}

/** A fake transport: every ref control the receiver sends is delivered to the writer, in order. */
function link(writer: PayloadRefWriter, options: { budget?: number } = {}) {
	const sent: RefControl[] = [];
	const deliveries: Promise<void>[] = [];
	const reader = new PayloadRefReader({
		root,
		generation: writer.generation,
		budget: options.budget,
		send: (control) => {
			sent.push(control);
			deliveries.push(writer.handle(control));
		},
	});
	return { reader, sent, delivered: () => Promise.all(deliveries) };
}

function received(frame: Uint8Array): ToolChildMessage {
	const [message] = new FrameDecoder().push(frame);
	if (message === undefined) throw new Error("no frame decoded");
	return message;
}

/**
 * The delayed-consumption scenario: the writer sends a 5 MiB `result_ref`, its sender-side operation settles, and the
 * receiver opens the file only later, behind an event gate. `onSenderSettled` is the writer's settlement behavior.
 */
async function delayedConsumption(onSenderSettled: (ref: PayloadRef) => Promise<void>) {
	const writer = new PayloadRefWriter({ root, generation: 1 });
	const { reader, sent, delivered } = link(writer);
	const payload = bytesOf(5 * MIB);
	const ref = await writer.create(payload);
	const frame = received(encodeFrame({ type: "result_ref", jobId: "j1", ref }));
	if (frame.type !== "result_ref") throw new Error("expected result_ref");
	const gate = deferred();
	const consumer = (async () => {
		await gate.promise;
		const acceptance = await reader.accept(frame.ref);
		await delivered();
		const existsAfterAck = await exists(refFilePath(root, frame.ref));
		const bytes = acceptance.ok ? await reader.consume(frame.ref.refId) : undefined;
		return { acceptance, existsAfterAck, bytes };
	})();
	await onSenderSettled(ref);
	const existsAfterSettlement = await exists(refFilePath(root, ref));
	gate.resolve();
	const consumed = await consumer;
	return {
		existsAfterSettlement,
		...consumed,
		sha256Verified:
			consumed.bytes !== undefined && createHash("sha256").update(consumed.bytes).digest("hex") === ref.sha256,
		sent,
		writerPending: writer.pendingIds(),
		existsAfterConsume: await exists(refFilePath(root, ref)),
	};
}

type Scenario = Awaited<ReturnType<typeof delayedConsumption>>;

const meetsOwnershipTransfer = (result: Scenario): boolean =>
	result.existsAfterSettlement &&
	result.acceptance.ok &&
	result.existsAfterAck &&
	result.sha256Verified &&
	result.sent.length === 1 &&
	result.sent[0]?.type === "ref_ack" &&
	result.writerPending.length === 0 &&
	!result.existsAfterConsume;

describe("payload ref lifetime", () => {
	it("delayed consumption: the file outlives sender-side settlement, ownership moves on ref_ack, the owner deletes", async () => {
		const result = await delayedConsumption(async () => undefined);
		expect(result.existsAfterSettlement).toBe(true);
		expect(result.acceptance).toEqual({ ok: true });
		expect(result.sent).toEqual([{ type: "ref_ack", refId: expect.any(String) }]);
		expect(result.existsAfterAck).toBe(true);
		expect(result.sha256Verified).toBe(true);
		expect(result.existsAfterConsume).toBe(false);
		expect(meetsOwnershipTransfer(result)).toBe(true);
	});

	it("delayed consumption negative control: the old writer-deletes-on-settlement rule is rejected", async () => {
		const oldRule = (ref: PayloadRef) => rm(refFilePath(root, ref), { force: true });
		const result = await delayedConsumption(oldRule);
		expect(result.acceptance).toEqual({ ok: false, reason: "missing" });
		expect(result.sent).toEqual([{ type: "ref_nack", refId: expect.any(String), reason: "missing" }]);
		expect(meetsOwnershipTransfer(result)).toBe(false);
	});

	it("a corrupted file is nacked and the writer deletes it", async () => {
		const writer = new PayloadRefWriter({ root, generation: 1 });
		const { reader, sent, delivered } = link(writer);
		const ref = await writer.create(bytesOf(1024));
		await writeFile(refFilePath(root, ref), bytesOf(1024, 99));
		expect(await reader.accept(ref)).toEqual({ ok: false, reason: "corrupt" });
		await delivered();
		expect(sent).toEqual([{ type: "ref_nack", refId: ref.refId, reason: "corrupt" }]);
		expect(await exists(refFilePath(root, ref))).toBe(false);
		expect(writer.pendingIds()).toEqual([]);
		expect(writer.ownedBytes).toBe(0);
	});

	it("cancellation before ack sends ref_nack{cancelled} and the writer deletes", async () => {
		const writer = new PayloadRefWriter({ root, generation: 1 });
		const { reader, sent, delivered } = link(writer);
		const first = await writer.create(bytesOf(2048));
		const second = await writer.create(bytesOf(2048));
		const controller = new AbortController();
		controller.abort();
		expect(await reader.accept(first, controller.signal)).toEqual({ ok: false, reason: "cancelled" });
		reader.refuse(second, "cancelled");
		await delivered();
		expect(sent).toEqual([
			{ type: "ref_nack", refId: first.refId, reason: "cancelled" },
			{ type: "ref_nack", refId: second.refId, reason: "cancelled" },
		]);
		expect(await exists(refFilePath(root, first))).toBe(false);
		expect(await exists(refFilePath(root, second))).toBe(false);
	});

	it("receiver death before ack: generation teardown deletes the ref and spool/", async () => {
		const writer = new PayloadRefWriter({ root, generation: 4 });
		const ref = await writer.create(bytesOf(4096));
		received(encodeFrame({ type: "result_ref", jobId: "j1", ref }));
		await mkdir(spoolDir(root, 4), { recursive: true });
		await writeFile(join(spoolDir(root, 4), "entry-1.chunk"), "spooled");
		await writer.teardown();
		expect(await exists(refFilePath(root, ref))).toBe(false);
		expect(await exists(spoolDir(root, 4))).toBe(false);
		expect(writer.pendingIds()).toEqual([]);
	});

	it("death before ack of an earlier process: the generation sweep removes every generation that is not live", async () => {
		const stale = new PayloadRefWriter({ root, generation: 2 });
		const staleRef = await stale.create(bytesOf(64));
		await mkdir(spoolDir(root, 2), { recursive: true });
		const live = new PayloadRefWriter({ root, generation: 3 });
		const liveRef = await live.create(bytesOf(64));
		expect(await sweepRefGenerations(root, new Set([3]))).toEqual([2]);
		expect(await exists(refFilePath(root, staleRef))).toBe(false);
		expect(await exists(spoolDir(root, 2))).toBe(false);
		expect(await exists(refFilePath(root, liveRef))).toBe(true);
	});

	it("an acked ref whose owner dies is deleted by the teardown sweep", async () => {
		const writer = new PayloadRefWriter({ root, generation: 1 });
		const { reader, delivered } = link(writer);
		const ref = await writer.create(bytesOf(8192));
		expect(await reader.accept(ref)).toEqual({ ok: true });
		await delivered();
		expect(writer.pendingIds()).toEqual([]);
		expect(reader.ownedIds()).toEqual([ref.refId]);
		expect(await exists(refFilePath(root, ref))).toBe(true);
		await teardownRefGeneration(root, 1);
		expect(await exists(refFilePath(root, ref))).toBe(false);
	});

	it("refuses a ref past refsBudget with ref_budget_exceeded, on both sides", async () => {
		expect(new PayloadRefWriter({ root, generation: 1 }).budget).toBe(TOOL_CHILD_LIMITS.refsBudget);
		const writer = new PayloadRefWriter({ root, generation: 1, budget: 6 * MIB });
		const first = await writer.create(bytesOf(5 * MIB));
		await expect(writer.create(bytesOf(2 * MIB))).rejects.toMatchObject({ code: "ref_budget_exceeded" });
		await expect(writer.create(bytesOf(2 * MIB))).rejects.toBeInstanceOf(PayloadRefError);
		expect(await readdir(join(refFilePath(root, first), ".."))).toEqual([first.refId]);
		const { reader, sent, delivered } = link(writer, { budget: 4 * MIB });
		expect(await reader.accept(first)).toEqual({ ok: false, reason: "budget" });
		await delivered();
		expect(sent).toEqual([{ type: "ref_nack", refId: first.refId, reason: "budget" }]);
		expect(writer.ownedBytes).toBe(0);
		await writer.create(bytesOf(5 * MIB));
	});

	it("reports an unacknowledged ref overdue after refAckMs without deleting it", async () => {
		let now = 1_000;
		const writer = new PayloadRefWriter({ root, generation: 1, now: () => now });
		const ref = await writer.create(bytesOf(16));
		now += TOOL_CHILD_LIMITS.refAckMs - 1;
		expect(writer.overdue()).toEqual([]);
		now += 1;
		expect(writer.overdue()).toEqual([ref.refId]);
		expect(await exists(refFilePath(root, ref))).toBe(true);
	});
});

describe("payloads above the reference threshold, in both directions", () => {
	it("a 17 MiB host_call.args (child -> server) round-trips by acknowledged reference", async () => {
		const childWriter = new PayloadRefWriter({ root, generation: 5 });
		const { reader: serverReader, sent, delivered } = link(childWriter);
		const args = { path: "big.txt", content: "a".repeat(17 * MIB) };
		const inlineAttempt = () =>
			encodeFrame({ type: "host_call", callId: "c1", jobId: "j1", kind: "tool", name: "write", args });
		expect(inlineAttempt).toThrow(ToolChildCodecError);
		const packed = await packPayload(args, childWriter);
		if (packed.inline) throw new Error("17 MiB args must move by reference");
		const frame = received(
			encodeFrame({
				type: "host_call",
				callId: "c1",
				jobId: "j1",
				kind: "tool",
				name: "write",
				argsRef: packed.ref,
			}),
		);
		if (frame.type !== "host_call" || frame.argsRef === undefined) throw new Error("expected host_call with argsRef");
		expect(await unpackPayload(frame.argsRef, serverReader)).toEqual(args);
		await delivered();
		expect(sent).toEqual([{ type: "ref_ack", refId: packed.ref.refId }]);
		expect(await exists(refFilePath(root, packed.ref))).toBe(false);
		expect(childWriter.pendingIds()).toEqual([]);
	});

	it("a 20 MiB host_reply.value (server -> child) round-trips by acknowledged reference", async () => {
		const serverWriter = new PayloadRefWriter({ root, generation: 5 });
		const { reader: childReader, sent, delivered } = link(serverWriter);
		const value = "v".repeat(20 * MIB);
		const packed = await packPayload(value, serverWriter);
		if (packed.inline) throw new Error("20 MiB value must move by reference");
		const frame = received(encodeFrame({ type: "host_reply", callId: "c1", valueRef: packed.ref }));
		if (frame.type !== "host_reply" || frame.valueRef === undefined)
			throw new Error("expected host_reply with valueRef");
		expect(await unpackPayload(frame.valueRef, childReader)).toEqual(value);
		await delivered();
		expect(sent).toEqual([{ type: "ref_ack", refId: packed.ref.refId }]);
		expect(await exists(refFilePath(root, packed.ref))).toBe(false);
	});

	it("keeps a payload at or below REF_THRESHOLD inline and writes no file", async () => {
		const writer = new PayloadRefWriter({ root, generation: 1 });
		expect(await packPayload({ small: true }, writer)).toEqual({ inline: true, value: { small: true } });
		expect(await exists(join(root, "gen-1"))).toBe(false);
	});

	it("unpackPayload rejects a ref it had to nack", async () => {
		const writer = new PayloadRefWriter({ root, generation: 1 });
		const { reader } = link(writer);
		const packed = await packPayload("x".repeat(TOOL_CHILD_LIMITS.REF_THRESHOLD + 1), writer);
		if (packed.inline) throw new Error("expected a ref");
		await rm(refFilePath(root, packed.ref));
		await expect(unpackPayload(packed.ref, reader)).rejects.toMatchObject({
			code: "ref_rejected",
			reason: "missing",
		});
	});
});
