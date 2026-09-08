import { expect, it } from "vitest";
import {
	MAX_SHARED_STDIO_QUEUE_BYTES,
	MAX_SHARED_STDIO_QUEUE_RECORDS,
} from "../../src/modes/rpc/session-event-writer.ts";
import { startWorkerHost } from "./rpc-worker-host-support.ts";
import { observePressure, PRESSURE_BYTES, pressureExtension, pressurePreload } from "./rpc-worker-pressure-support.ts";
import { reservationPhase as pressureStep } from "./rpc-worker-reservation-support.ts";

it("reports oversized worker output as a session-specific failure without terminating siblings", async () => {
	const host = await startWorkerHost(`export default function (pi) {
		pi.registerCommand("overflow", { description: "test output bound", handler: async (_args, ctx) => {
			ctx.ui.notify("x".repeat(16 * 1024 * 1024), "info");
		} });
	}`);
	try {
		const a = await host.request({ type: "open_session", cwd: host.cwd });
		const b = await host.request({ type: "open_session", cwd: host.cwd });
		expect(a.success).toBe(true);
		expect(b.success).toBe(true);
		const failure = host.wait((record) => record.type === "session_error" && record.sessionId === a.data?.sessionId);
		const command = host.request({ type: "prompt", sessionId: a.data?.sessionId, message: "/overflow" });
		const results = Promise.allSettled([failure, command]);
		expect((await failure).error).toBe("session_worker_output_limit");
		expect((await command).success).toBe(false);
		await results;
		const sibling = await host.request({ type: "get_state", sessionId: b.data?.sessionId });
		expect(sibling.success).toBe(true);
		expect(sibling.data?.sessionId).toBe(b.data?.state?.sessionId);
	} finally {
		await host.dispose();
	}
}, 60_000);

it.each([false, true])(
	"preserves terminal records through repeated native backpressure (socket=%s)",
	async (socket) => {
		// Node's --import observer calls through to the real CLI's Socket and writer methods.
		// No writable result, callback, queue, drain event, or worker is substituted.
		const host = await startWorkerHost(pressureExtension, { node: true, socket, preload: pressurePreload() });
		const signals = observePressure(host.child.stderr);
		const wire = socket ? await host.connect() : host;
		const peer = socket ? await host.connect() : host;
		const pending: Promise<PromiseSettledResult<unknown>[]>[] = [];
		const track = <T>(promise: Promise<T>): Promise<T> => {
			pending.push(Promise.allSettled([promise]));
			return promise;
		};
		try {
			const a = await wire.request({ type: "open_session", cwd: host.cwd });
			const b = await peer.request({ type: "open_session", cwd: host.cwd });
			expect(a.success).toBe(true);
			expect(b.success).toBe(true);
			const sessionId = a.data?.sessionId;
			if (!sessionId) throw new Error("Missing pressure session");
			for (let phase = 0; phase < 3; phase++) {
				const blocked = track(signals.wait("BLOCKED", phase));
				const drained = track(signals.wait("DRAIN", phase));
				const commandId = `pressure-command:${phase}`;
				const command = track(wire.wait((record) => record.type === "response" && record.id === commandId));
				wire.pauseReading();
				wire.send({ id: commandId, type: "prompt", sessionId, message: `/pressure ${phase}` });
				const pressure = await blocked;
				expect(pressure.pid).toBe(host.child.pid);
				expect(pressure.needDrain).toBe(true);
				expect(pressure.pendingBytes).toBeGreaterThan(0);

				// An independent command is processed while the real OS transport stays full.
				// The observer captures native queue state when its response is enqueued.
				const probeId = `pressure-probe:${phase}`;
				const probed = track(signals.wait("PROBE", phase));
				const probeResponse = track(wire.wait((record) => record.type === "response" && record.id === probeId));
				wire.send({ id: probeId, type: "list_sessions" });
				const held = await probed;
				expect(held.needDrain).toBe(true);
				expect(held.pendingBytes).toBeGreaterThan(0);
				expect(held.credit).toBe(0);
				expect(held.bufferedBytes).toBeLessThanOrEqual(MAX_SHARED_STDIO_QUEUE_BYTES);
				expect(held.bufferedRecords).toBeLessThanOrEqual(MAX_SHARED_STDIO_QUEUE_RECORDS);
				if (socket) {
					const sibling = await peer.request({ type: "get_state", sessionId: b.data?.sessionId });
					expect(sibling.success).toBe(true);
					expect(sibling.data?.sessionId).toBe(b.data?.state?.sessionId);
				}
				if (phase < 2) {
					wire.resumeReading();
					await drained;
					expect((await probeResponse).success).toBe(true);
					expect((await command).success).toBe(true);
					const prefix = `PRESSURE_PAYLOAD:${phase}:`;
					const payloads = wire.records.filter(
						(record) => record.sessionId === sessionId && record.message?.startsWith(prefix),
					);
					expect(payloads.map((record) => Number(record.message?.split(":", 3)[2]))).toEqual([0, 1]);
					for (const record of payloads)
						expect(record.message?.length).toBe(PRESSURE_BYTES + `${prefix}0:`.length);
					process.stderr.write(
						`PRESSURE_ROUND ${JSON.stringify({ socket, phase, pendingBytes: held.pendingBytes, credit: held.credit, records: payloads.length })}\n`,
					);
					continue;
				}

				// Close is enqueued before reading resumes, not after the saturation disappears.
				const terminalQueued = track(signals.wait("TERMINAL", phase));
				const closed = track(
					wire.wait((record) => record.type === "session_closed" && record.sessionId === sessionId),
				);
				const closeId = "pressure-close";
				const terminal = track(wire.wait((record) => record.type === "response" && record.id === closeId, 10_000));
				wire.send({ id: closeId, type: "close_session", sessionId });
				const queued = await terminalQueued;
				expect(queued.needDrain).toBe(true);
				expect(queued.pendingBytes).toBeGreaterThan(0);
				expect(queued.bufferedBytes).toBeLessThanOrEqual(MAX_SHARED_STDIO_QUEUE_BYTES);
				wire.resumeReading();
				await drained;
				await closed;
				expect(await terminal).toMatchObject({ command: "close_session", sessionId, success: true });
				expect((await command).success).toBe(false);
				expect((await probeResponse).success).toBe(true);
				await wire.request({ type: "list_sessions" });
				const sessionRecords = wire.records.filter((record) => record.sessionId === sessionId);
				expect(sessionRecords.at(-1)).toMatchObject({ type: "response", id: closeId, command: "close_session" });
				expect(sessionRecords.filter((record) => record.type === "session_closed")).toHaveLength(1);
				process.stderr.write(
					`PRESSURE_TERMINAL_PROOF ${JSON.stringify({ socket, queuedBytes: queued.pendingBytes, terminalId: closeId })}\n`,
				);
			}
			const sibling = await pressureStep(
				`pressure-${socket}-sibling-state`,
				peer.request({ type: "get_state", sessionId: b.data?.sessionId }),
			);
			expect(sibling.success).toBe(true);
			expect(sibling.data?.sessionId).toBe(b.data?.state?.sessionId);
			expect(
				(
					await pressureStep(
						`pressure-${socket}-sibling-close`,
						peer.request({ type: "close_session", sessionId: b.data?.sessionId }),
					)
				).success,
			).toBe(true);
		} finally {
			wire.resumeReading();
			try {
				// Keep the diagnostic reader flowing until the child closes its stdio.
				await pressureStep(`pressure-${socket}-host-cleanup`, host.dispose());
			} finally {
				signals.dispose();
				await pressureStep(`pressure-${socket}-watcher-cleanup`, Promise.all(pending));
			}
		}
	},
	60_000,
);
