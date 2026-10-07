import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SESSION_WORKER_LIMITS } from "../../src/modes/rpc/session-worker-protocol.ts";
import { waitForFifoReader } from "./rpc-worker-host-support.ts";
import { reservationPhase as phase, reservationHost } from "./rpc-worker-reservation-support.ts";

it.each(["close", "deadline"])(
	"repeated %s retains real-worker ownership until late exit and isolates replacement epochs",
	async (action) => {
		const scratch = await mkdtemp(join(tmpdir(), "senpi-worker-reservation-"));
		const cwd = join(scratch, "cwd");
		const agentDir = join(scratch, "agent");
		await mkdir(cwd);
		await mkdir(agentDir);
		const sessionFile = join(scratch, "blocked.jsonl");
		const fifo = join(scratch, "native-gate");
		const armed = join(scratch, "block-next-open");
		const extension = join(scratch, "native-gate.mjs");
		const alias = join(scratch, "alias.jsonl");
		const siblingFile = join(scratch, "sibling.jsonl");
		const header = (id: string) =>
			`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd })}\n`;
		await writeFile(sessionFile, header("blocked-durable"));
		await symlink(sessionFile, alias);
		await writeFile(siblingFile, header("sibling-durable"));
		await writeFile(
			extension,
			`import { execFileSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
export default function () {
	if (!existsSync(${JSON.stringify(armed)})) return;
	unlinkSync(${JSON.stringify(armed)});
	execFileSync(process.execPath, ["-e", "require('node:fs').readFileSync(process.argv[1])", ${JSON.stringify(fifo)}], { stdio: "ignore" });
}`,
		);
		vi.stubEnv("PATH", "/usr/bin:/bin");
		vi.stubEnv("SENPI_OFFLINE", "1");
		const host = reservationHost(cwd, agentDir, extension);
		const epochs = [host];
		host.connect("sibling");
		host.connect("control");
		let siblingId: string | undefined;
		let firstHandle: string | undefined;
		let releaseGate: (() => Promise<void>) | undefined;
		try {
			for (let round = 0; round < 3; round++) {
				if (round > 0) await unlink(fifo);
				execFileSync("mkfifo", [fifo]);
				await writeFile(armed, "");
				const canonical = await realpath(sessionFile);
				const durable = `retry-${action}-${round}`;
				let gate: Awaited<ReturnType<typeof open>> | undefined;
				let releasing: Promise<void> | undefined;
				releaseGate = () =>
					(releasing ??= (async () => {
						// Keep both ends open while replacing the fixture path. This also
						// rescues cleanup if the worker failed before the writer-open signal.
						const rescue = await open(fifo, "r+");
						try {
							await unlink(fifo);
							await writeFile(fifo, header(durable));
							await writeFile(sessionFile, header(durable));
							await rescue.write(header(durable));
						} finally {
							await Promise.all([gate?.close(), rescue.close()]);
							gate = undefined;
						}
					})());
				const oldPeer = `opening-${round}`;
				host.connect(oldPeer);
				if (action === "deadline") vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
				// A worker's own FIFO open is not a stable native gate: writer-open
				// releases open(2), so termination can win before read(2). Here the
				// child's FIFO entry proves the worker is already in execFileSync;
				// it cannot leave that native call until we release the child.
				const reader = waitForFifoReader(fifo);
				const opening = host.send(oldPeer, { id: oldPeer, type: "open_session", cwd, sessionPath: sessionFile });
				gate = await reader;
				const handle = host.registry.list().find((entry) => entry.sessionPath === canonical)?.sessionId;
				if (!handle) throw new Error("Blocked worker is missing");
				firstHandle ??= handle;
				const worker = host.registry.peek(handle)?.worker;
				if (!worker) throw new Error("Native worker is missing");
				const exited = worker.exited;
				if (!siblingId) {
					await phase(
						"open-sibling",
						host.send("sibling", { type: "open_session", cwd, sessionPath: siblingFile }),
					);
					siblingId = host.registry
						.list()
						.find((entry) => entry.durableSessionId === "sibling-durable")?.sessionId;
					if (!siblingId) throw new Error("Sibling worker is missing");
				}
				const disconnected = host.disconnect(oldPeer);
				if (action === "close") await phase("cancel-opening", host.registry.close(handle));
				else await vi.advanceTimersByTimeAsync(SESSION_WORKER_LIMITS.openMs);
				vi.useRealTimers();
				expect(await phase("opening-cancelled", opening)).toMatchObject({ success: false });
				await phase("old-connection-release", disconnected);
				expect(host.exited.has(worker)).toBe(false);
				expect(host.registry.peek(handle)?.state).toBe("quarantined");
				expect(host.registry.list().find((entry) => entry.sessionId === handle)?.status).toBe("closing");
				expect(host.registry.size).toBe(2);
				const attachments = host.registry.peek(handle)?.attachments;
				const allocated = host.workers.size;
				for (let attempt = 0; attempt < 4; attempt++) {
					await phase("repeat-cancel", host.registry.close(handle));
					expect(
						await host.send("control", { type: "open_session", cwd, sessionPath: sessionFile }),
					).toMatchObject({
						success: false,
						error: expect.stringContaining("session_path_in_use"),
					});
					expect(host.registry.size).toBe(2);
					expect(host.registry.peek(handle)?.attachments).toBe(attachments);
					expect(host.workers.size).toBe(allocated);
				}
				const previousWorkers = new Set(host.workers);
				const competing = host.send("control", { type: "open_session", cwd, sessionPath: alias });
				const challengers = [...host.workers].filter((candidate) => !previousWorkers.has(candidate));
				expect(challengers).toHaveLength(1);
				expect(await phase("alias-denied", competing)).toMatchObject({
					success: false,
					error: expect.stringContaining("session_path_in_use"),
				});
				await phase("challenger-exit", Promise.all(challengers.map((candidate) => candidate.exited)));
				expect(host.registry.size).toBe(2);
				expect(host.exited.has(worker)).toBe(false);
				const siblingProbe = `sibling-during-${round}`;
				await phase(
					"sibling-while-quarantined",
					host.send("sibling", { id: siblingProbe, type: "get_state", sessionId: siblingId }),
				);
				await host.writer.flush();
				expect(host.records).toContainEqual(
					expect.objectContaining({
						id: siblingProbe,
						success: true,
						data: expect.objectContaining({ sessionId: "sibling-durable" }),
					}),
				);
				await phase("release-native-reader", releaseGate());
				releaseGate = undefined;
				await phase("late-native-exit", exited);
				expect(host.registry.peek(handle)).toBeUndefined();
				expect(host.registry.size).toBe(1);

				const replacement = `replacement-${round}`;
				const survivor = `survivor-${round}`;
				host.connect(replacement);
				host.connect(survivor);
				await phase("same-path-retry", host.send(replacement, { type: "open_session", cwd, sessionPath: alias }));
				const retry = host.registry.list().find((entry) => entry.durableSessionId === durable)?.sessionId;
				if (!retry) throw new Error("Replacement worker is missing");
				expect(retry).not.toBe(handle);
				const beforeAttach = host.workers.size;
				await host.send(survivor, { type: "open_session", cwd, sessionPath: canonical });
				expect(host.workers.size).toBe(beforeAttach);
				expect(host.registry.peek(retry)?.attachments).toBe(2);
				worker.quarantine();
				await host.router.releaseConnection(oldPeer);
				expect(await host.send("control", { type: "close_session", sessionId: handle })).toMatchObject({
					success: false,
					error: "unknown_session",
				});
				expect(host.registry.peek(retry)?.attachments).toBe(2);
				await host.disconnect(replacement);
				expect(host.registry.peek(retry)?.attachments).toBe(1);
				const stateId = `state-${round}`;
				await host.send(survivor, { id: stateId, type: "get_state", sessionId: retry });
				await host.writer.flush();
				expect(host.records).toContainEqual(
					expect.objectContaining({
						id: stateId,
						success: true,
						data: expect.objectContaining({ sessionId: durable }),
					}),
				);
				const retryExit = host.registry.peek(retry)?.worker?.exited;
				await host.disconnect(survivor);
				await phase("replacement-exit", retryExit ?? Promise.reject(new Error("Missing replacement exit")));
				expect(host.registry.size).toBe(1);
				expect(host.registry.peek(siblingId)?.worker?.snapshot?.state.sessionId).toBe("sibling-durable");
				process.stderr.write(
					`WORKER_REPEAT_PROOF ${JSON.stringify({ action, round, handle, retry, allocated: host.workers.size, exited: host.exited.size, retained: host.registry.size, peak: host.peak })}\n`,
				);
			}
			await host.dispose();
			expect(host.registry.size).toBe(0);
			expect(host.exited.size).toBe(host.workers.size);
			expect(host.peak).toBe(3);
			expect(host.births.every((birth) => birth.threadId > 0)).toBe(true);

			// A fresh host-core epoch may reuse rpc-1, but old cleanup must stay
			// scoped to the retired registry/router, never the new attachments.
			const next = reservationHost(cwd, agentDir);
			epochs.push(next);
			next.connect("replacement-0");
			next.connect("epoch-survivor");
			await next.send("replacement-0", { type: "open_session", cwd, sessionPath: sessionFile });
			const replacement = next.registry.list()[0];
			expect(replacement.sessionId).toBe(firstHandle);
			await next.send("epoch-survivor", { type: "open_session", cwd, sessionPath: replacement.sessionPath });
			expect(next.workers.size).toBe(1);
			expect(next.registry.peek(replacement.sessionId)?.attachments).toBe(2);
			await host.router.releaseConnection("replacement-0");
			await host.router.dispose();
			for (const worker of host.workers) worker.quarantine();
			expect(await host.send("control", { type: "close_session", sessionId: replacement.sessionId })).toMatchObject({
				success: false,
				error: "unknown_session",
			});
			expect(next.registry.peek(replacement.sessionId)?.attachments).toBe(2);
			await next.disconnect("replacement-0");
			expect(next.registry.peek(replacement.sessionId)?.attachments).toBe(1);
			await next.send("epoch-survivor", { id: "epoch-state", type: "get_state", sessionId: replacement.sessionId });
			await next.writer.flush();
			expect(next.records).toContainEqual(
				expect.objectContaining({
					id: "epoch-state",
					success: true,
					data: expect.objectContaining({ sessionId: `retry-${action}-2` }),
				}),
			);
			process.stderr.write(
				`WORKER_EPOCH_PROOF ${JSON.stringify({ action, reusedHandle: replacement.sessionId, retainedAttachments: 1 })}\n`,
			);
		} finally {
			vi.useRealTimers();
			try {
				try {
					await releaseGate?.();
				} finally {
					await Promise.all(epochs.map((epoch) => epoch.dispose()));
				}
			} finally {
				vi.unstubAllEnvs();
				await rm(scratch, { recursive: true, force: true });
			}
		}
	},
	60_000,
);
