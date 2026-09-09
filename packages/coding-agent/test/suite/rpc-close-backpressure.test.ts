import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import {
	MAX_SHARED_STDIO_QUEUE_BYTES,
	MAX_SHARED_STDIO_QUEUE_RECORDS,
	SessionEventWriter,
} from "../../src/modes/rpc/session-event-writer.ts";
import { waitForFifoReader } from "./rpc-worker-host-support.ts";
import { reservationPhase as phase, reservationHost } from "./rpc-worker-reservation-support.ts";

const overflow = { type: "overflow", command: "close_session", error: "rpc_close_output_overflow, resync required" };
const response = (id: string) => ({ type: "response", command: "close_session", id, success: true });

// PR1499: independent held-scheduler RED, extended to bytes and observable recovery.
it.each(["records", "bytes"])("bounds duplicate close %s without dropping admitted terminal records", async (limit) => {
	const records: Array<Record<string, unknown>> = [];
	const writer = new SessionEventWriter(
		(line) => records.push(JSON.parse(line)),
		(_flush) => {},
	);
	const count = limit === "records" ? MAX_SHARED_STDIO_QUEUE_RECORDS + 100 : 70;
	const id = limit === "records" ? "" : "x".repeat(1024 * 1024);
	writer.closeSession("rpc-1", response("first"));
	try {
		for (let i = 0; i < count; i++) writer.enqueueClosedResponse("rpc-1", response(`${i}:${id}`));
		expect(writer.bufferedRecordCount).toBeLessThanOrEqual(MAX_SHARED_STDIO_QUEUE_RECORDS + 1);
		expect(writer.bufferedByteLength).toBeLessThanOrEqual(
			MAX_SHARED_STDIO_QUEUE_BYTES + JSON.stringify(overflow).length + 1,
		);
		await writer.flush();
		expect(records.filter((record) => record.type === "overflow")).toEqual([overflow]);
		const replies = records.filter((record) => record.sessionId === "rpc-1");
		expect(replies.slice(0, 2)).toEqual([
			{ type: "session_closed", sessionId: "rpc-1" },
			{ ...response("first"), sessionId: "rpc-1" },
		]);
		expect(replies.slice(2).map((record) => record.id)).toEqual(
			Array.from({ length: replies.length - 2 }, (_, i) => `${i}:${id}`),
		);
		expect(replies.length - 2).toBeLessThan(count);
		writer.enqueueClosedResponse("rpc-1", response("after-drain"));
		await writer.flush();
		expect(records.at(-1)).toEqual({ ...response("after-drain"), sessionId: "rpc-1" });
	} finally {
		await writer.flush();
	}
});

it.each([false, true])("scopes close overflow to affected socket requesters (late peer=%s)", async (latePeer) => {
	const writer = new SessionEventWriter(() => {});
	const a: Array<Record<string, unknown>> = [];
	const b: Array<Record<string, unknown>> = [];
	const drained = Promise.withResolvers<void>();
	const disconnected: string[] = [];
	let noticeWritten: (() => void) | undefined;
	const connectB = () =>
		writer.registerConnection("b", {
			writeRaw: (line) => {
				const record = JSON.parse(line);
				b.push(record);
				if (record.type === "overflow") noticeWritten?.();
			},
			waitForBackpressure: () => Promise.resolve(),
			close: () => disconnected.push("b"),
		});
	writer.registerConnection("a", {
		writeRaw: (line) => a.push(JSON.parse(line)),
		waitForBackpressure: () => drained.promise,
		close: () => disconnected.push("a"),
	});
	if (!latePeer) connectB();
	const admitted = [];
	try {
		// These are the same real admission tokens that joined router closes
		// retain while their finalizer is pending; none has completed yet.
		for (let i = 0; i < MAX_SHARED_STDIO_QUEUE_RECORDS / 2; i++) {
			const reply = writer.withConnection("a", () => writer.reserveCloseResponse("rpc-a", response(String(i))));
			if (!reply) throw new Error("Premature admission failure");
			admitted.push(reply);
		}
		for (let i = 0; i < 100; i++)
			expect(
				writer.withConnection("a", () => writer.reserveCloseResponse("rpc-a", response("rejected-a"))),
			).toBeUndefined();
		expect(a).toEqual([overflow]);
		if (latePeer) connectB();
		// B still makes progress while A's notice is blocked at its sink
		// contract. B has not lost output and must not be told to resynchronize.
		await writer.withConnection("b", () =>
			writer.enqueueControl({ type: "response", id: "healthy-b", success: true }),
		);
		expect(b).toEqual([{ type: "response", id: "healthy-b", success: true }]);
		expect(disconnected).toEqual([]);
		// If B subsequently asks for capacity too, it needs its own notice even
		// though A's notice is still outstanding. Unregister/register is a new sink.
		for (let epoch = 0; epoch < 2; epoch++) {
			if (epoch > 0) {
				writer.unregisterConnection("b");
				connectB();
			}
			const notice = Promise.withResolvers<void>();
			noticeWritten = notice.resolve;
			expect(
				writer.withConnection("b", () => writer.reserveCloseResponse("rpc-b", response("rejected-b"))),
			).toBeUndefined();
			await phase("requester-overflow-written", notice.promise);
			expect(b.filter((record) => record.type === "overflow")).toHaveLength(epoch + 1);
		}
		expect(a).toEqual([overflow]);
		expect(writer.pendingCloseRecordCount).toBe(MAX_SHARED_STDIO_QUEUE_RECORDS);

		// Finish one admitted first closer while its notice is still blocked.
		// Then drain socket actors only (no stdio lane), and saturate the SAME
		// actors again. A global flush latch must not hide this later episode.
		const first = admitted.shift();
		if (!first) throw new Error("Missing first close reservation");
		writer.withConnection("a", () => first.complete(true));
		for (const reply of admitted.splice(0)) reply.release();
		drained.resolve();
		await phase("socket-only-first-episode-drained", writer.flush());
		expect(writer.pendingCloseRecordCount).toBe(0);
		expect(writer.pendingCloseByteLength).toBe(0);
		expect(a).toEqual([
			overflow,
			{ type: "session_closed", sessionId: "rpc-a" },
			{ ...response("0"), sessionId: "rpc-a" },
		]);
		for (let i = 0; i < MAX_SHARED_STDIO_QUEUE_RECORDS / 2; i++) {
			const reply = writer.withConnection("a", () => writer.reserveCloseResponse("rpc-a", response(`next-${i}`)));
			if (!reply) throw new Error("Admission did not recover after drain");
			admitted.push(reply);
		}
		for (let i = 0; i < 100; i++)
			expect(
				writer.withConnection("a", () => writer.reserveCloseResponse("rpc-a", response("next-rejected"))),
			).toBeUndefined();
		await phase("socket-only-second-episode-drained", writer.flush());
		expect(a.filter((record) => record.type === "overflow")).toHaveLength(2);
		expect(b.filter((record) => record.type === "overflow")).toHaveLength(2);
		const repeatedNotice = Promise.withResolvers<void>();
		noticeWritten = repeatedNotice.resolve;
		expect(
			writer.withConnection("b", () => writer.reserveCloseResponse("rpc-b", response("next-b"))),
		).toBeUndefined();
		await phase("same-peer-second-episode-notice", repeatedNotice.promise);
		expect(b.filter((record) => record.type === "overflow")).toHaveLength(3);
		expect(writer.pendingCloseRecordCount).toBe(MAX_SHARED_STDIO_QUEUE_RECORDS);
		expect(disconnected).toEqual([]);
	} finally {
		for (const reply of admitted) reply.release();
		drained.resolve();
		await writer.flush();
		writer.unregisterConnection("a");
		writer.unregisterConnection("b");
	}
});

it.each(["quarantined", "finalizing-records", "finalizing-bytes"])(
	"bounds real FIFO worker close debt while %s and retains ownership until native exit",
	async (state) => {
		const scratch = await mkdtemp(join(tmpdir(), "senpi-close-bound-"));
		const cwd = join(scratch, "cwd"),
			agentDir = join(scratch, "agent"),
			fifo = join(scratch, "blocked.jsonl");
		await mkdir(cwd);
		await mkdir(agentDir);
		execFileSync("mkfifo", [fifo]);
		vi.stubEnv("PATH", "/usr/bin:/bin");
		vi.stubEnv("SENPI_OFFLINE", "1");
		const host = reservationHost(cwd, agentDir);
		host.connect("opening");
		const records: Array<Record<string, unknown>> = [];
		const writer = new SessionEventWriter(
			(line) => records.push(JSON.parse(line)),
			(_flush) => {},
		);
		const router = new SessionCommandRouter(host.registry, writer, { cwd });
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const closeMarked = host.registry.closeMarked.bind(host.registry);
		const finalizing = state !== "quarantined";
		const teardown = vi.spyOn(host.registry, "closeMarked").mockImplementation(async (handle) => {
			entered.resolve();
			if (finalizing) await gate.promise;
			await closeMarked(handle);
		});
		let reader: Awaited<ReturnType<typeof open>> | undefined;
		const pending: Array<Promise<unknown>> = [];
		try {
			const opening = host.send("opening", { type: "open_session", cwd, sessionPath: fifo });
			pending.push(opening);
			reader = await waitForFifoReader(fifo);
			const entry = host.registry.list()[0];
			const worker = host.registry.peek(entry.sessionId)?.worker;
			if (!worker) throw new Error("Missing native worker");
			if (finalizing) {
				pending.push(router.handle({ type: "close_session", sessionId: entry.sessionId, id: "first" }));
				await phase("finalizer-entered", entered.promise);
			} else {
				await phase("cancel", host.registry.close(entry.sessionId));
				expect(await phase("opening-cancelled", opening)).toMatchObject({ success: false });
			}
			const attachments = host.registry.peek(entry.sessionId)?.attachments;
			const count = state === "finalizing-bytes" ? 70 : MAX_SHARED_STDIO_QUEUE_RECORDS + 100;
			const suffix = state === "finalizing-bytes" ? "x".repeat(1024 * 1024) : "";
			for (let i = 0; i < count; i++)
				pending.push(router.handle({ type: "close_session", sessionId: entry.sessionId, id: `${i}:${suffix}` }));
			// All calls have reached admission synchronously. No finalizer gate or
			// output scheduler has been released, so waiting replies must count now.
			const debt = writer.pendingCloseRecordCount;
			expect(writer.bufferedRecordCount + debt).toBeLessThanOrEqual(MAX_SHARED_STDIO_QUEUE_RECORDS + 1);
			expect(writer.bufferedByteLength + writer.pendingCloseByteLength).toBeLessThanOrEqual(
				MAX_SHARED_STDIO_QUEUE_BYTES + JSON.stringify(overflow).length + 1,
			);
			expect(debt).toBeLessThan(count * 2);
			expect(host.exited.has(worker)).toBe(false);
			expect(host.registry.peek(entry.sessionId)?.attachments).toBe(attachments);
			expect(await host.send("opening", { type: "open_session", cwd, sessionPath: fifo })).toMatchObject({
				success: false,
				error: expect.stringContaining("session_path_in_use"),
			});
			gate.resolve();
			await phase("close-replies-settled", Promise.all(pending));
			expect(writer.pendingCloseRecordCount).toBe(0);
			expect(writer.pendingCloseByteLength).toBe(0);
			expect(host.exited.has(worker)).toBe(false);
			expect(host.registry.peek(entry.sessionId)?.state).toBe("quarantined");
			await writer.flush();
			expect(records.filter((record) => record.type === "overflow")).toEqual([overflow]);
			const replies = records.filter((record) => record.sessionId === entry.sessionId);
			if (finalizing)
				expect(replies.splice(0, 2)).toEqual([
					{ type: "session_closed", sessionId: entry.sessionId },
					expect.objectContaining({ id: "first", success: true }),
				]);
			expect(replies.length).toBeGreaterThan(0);
			expect(replies.length).toBeLessThan(count);
			expect(replies.map((record) => record.id)).toEqual(
				Array.from({ length: replies.length }, (_, i) => `${i}:${suffix}`),
			);
			console.log("CLOSE_ADMISSION_PROOF", {
				state,
				debt,
				replies: replies.length,
				workerExited: host.exited.has(worker),
				registrySize: host.registry.size,
			});
		} finally {
			gate.resolve();
			const rescue = await open(fifo, "r+");
			try {
				await unlink(fifo);
				const header = `${JSON.stringify({ type: "session", version: 3, id: "bound-durable", timestamp: new Date(0).toISOString(), cwd })}\n`;
				await writeFile(fifo, header);
				await rescue.write(header);
			} finally {
				await Promise.all([reader?.close(), rescue.close()]);
			}
			await host.dispose();
			await Promise.all(pending);
			await router.dispose();
			await writer.flush();
			teardown.mockRestore();
			vi.unstubAllEnvs();
			await rm(scratch, { recursive: true, force: true });
		}
	},
	60_000,
);
