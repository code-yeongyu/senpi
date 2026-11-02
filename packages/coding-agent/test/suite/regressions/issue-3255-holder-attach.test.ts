import { once } from "node:events";
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { expect, it } from "vitest";
import { liveSessionHolders } from "../../../src/core/session-holders.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { readSessionPathClaims } from "../../../src/modes/rpc/host-reservations.ts";
import { startWorkerHost } from "../rpc-worker-host-support.ts";

async function persistSession(file: string, cwd: string): Promise<void> {
	await writeFile(
		file,
		`${JSON.stringify({
			type: "session",
			version: 3,
			id: "11111111-1111-4111-8111-111111111111",
			cwd,
			timestamp: "2026-10-13T00:00:00.000Z",
		})}\n`,
	);
}

it.each(["in-process", "worker"] as const)(
	"publishes discoverable public holder metadata and fences attachments on a %s host",
	async (sessionRuntime) => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const client = await host.connect();
			const identity = await client.request({ type: "get_protocol_info" });
			const instanceId = identity.data?.instanceId;
			expect(instanceId).toEqual(expect.any(String));
			const file = join(host.cwd, "held.jsonl");
			await persistSession(file, host.cwd);
			const opened = await client.request({ type: "open_session", sessionPath: file });
			expect(opened.success).toBe(true);
			const durableId = opened.data?.state?.sessionId;
			if (durableId === undefined) throw new Error("Host did not return durable identity");
			const recordsDir = join(dirname(file), "session-holders", durableId);
			const records = (await readdir(recordsDir)).filter((name) => name.endsWith(".json"));
			expect(records).toHaveLength(1);
			const recordPath = join(recordsDir, records[0]);
			const evidence = JSON.parse(await readFile(recordPath, "utf8"));
			const publicSocket = await realpath(host.socketPath);
			expect(evidence).toMatchObject({ host_socket: publicSocket, host_instance: instanceId });
			expect(await liveSessionHolders(file, durableId)).toEqual([
				expect.objectContaining({ host_socket: publicSocket, host_instance: instanceId }),
			]);
			const paths = createHostDaemonPaths({ socket: host.socketPath, agentDir: host.agentDir });
			expect(await readSessionPathClaims(paths.reservationsDir)).toEqual([
				expect.objectContaining({
					owner: expect.objectContaining({ host_socket: publicSocket, instanceId }),
				}),
			]);
			const other = await host.connect();
			const before = await readFile(recordPath, "utf8");
			const refused = await other.request({
				type: "open_session",
				sessionPath: file,
				expectedHostInstance: "a-stale-host-instance",
			});
			expect(refused).toMatchObject({
				success: false,
				errorCode: "owner_changed",
				errorData: { reason: "host_instance_mismatch", action: "rediscover_holder" },
			});
			expect(await readFile(recordPath, "utf8")).toBe(before);
			const attached = await other.request({
				type: "open_session",
				sessionPath: file,
				expectedHostInstance: instanceId,
			});
			expect(attached).toMatchObject({
				success: true,
				data: { attached: true, sessionId: opened.data?.sessionId },
			});
			expect((await other.request({ type: "list_sessions" })).data?.sessions).toHaveLength(1);
			const followUp = {
				type: "follow_up",
				sessionId: attached.data?.sessionId,
				message: "one follow-up through the holder",
				clientMessageId: "holder-follow-up",
				clientTurnId: "holder-turn",
			};
			expect(await other.request(followUp)).toMatchObject({
				success: true,
				data: { admission: { state: "queued", clientMessageId: "holder-follow-up" } },
			});
			expect(await other.request(followUp)).toMatchObject({
				success: true,
				data: { admission: { state: "queued", clientMessageId: "holder-follow-up" } },
			});
			expect(await other.request({ type: "get_state", sessionId: attached.data?.sessionId })).toMatchObject({
				data: { ordered: [expect.objectContaining({ clientMessageId: "holder-follow-up" })] },
			});
		} finally {
			await host.dispose();
		}
	},
	60_000,
);

it.each(["in-process", "worker"] as const)(
	"never creates a writer for an attach-only request on a %s host",
	async (sessionRuntime) => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime });
		try {
			const client = await host.connect();
			const identity = await client.request({ type: "get_protocol_info" });
			const refused = await client.request({
				type: "open_session",
				sessionPath: join(host.cwd, "unheld.jsonl"),
				expectedHostInstance: identity.data?.instanceId,
			});
			expect(refused).toMatchObject({
				success: false,
				errorCode: "session_not_held",
				errorData: { reason: "session_not_held", action: "rediscover_holder" },
			});
			expect((await client.request({ type: "list_sessions" })).data?.sessions).toEqual([]);
		} finally {
			await host.dispose();
		}
	},
	60_000,
);

it("validates legacy and stale holder evidence against the live host without trusting missing metadata", async () => {
	const host = await startWorkerHost(undefined, { socket: true, sessionRuntime: "in-process" });
	try {
		const client = await host.connect();
		const file = join(host.cwd, "legacy.jsonl");
		await persistSession(file, host.cwd);
		const opened = await client.request({ type: "open_session", sessionPath: file });
		const id = opened.data?.state?.sessionId;
		if (id === undefined) throw new Error("Host did not return durable identity");
		const recordPath = join(dirname(file), "session-holders", id, `${host.child.pid}.json`);
		const evidence = JSON.parse(await readFile(recordPath, "utf8"));
		delete evidence.host_socket;
		delete evidence.host_instance;
		await writeFile(recordPath, JSON.stringify(evidence));
		expect(await liveSessionHolders(file, id)).toEqual([expect.objectContaining({ pid: host.child.pid })]);
		const replacement = await startWorkerHost(undefined, { socket: true, sessionRuntime: "in-process" });
		try {
			const other = await replacement.connect();
			expect(await other.request({ type: "open_session", sessionPath: file })).toMatchObject({
				success: false,
				errorCode: "session_held",
			});
			const live = await client.request({ type: "get_protocol_info" });
			const stale = await client.request({
				type: "open_session",
				sessionPath: file,
				expectedHostInstance: "old-generation",
			});
			expect(stale).toMatchObject({ success: false, errorCode: "owner_changed" });
			expect(
				await client.request({
					type: "open_session",
					sessionPath: file,
					expectedHostInstance: live.data?.instanceId,
				}),
			).toMatchObject({ success: true, data: { attached: true } });
			const exited = once(host.child, "exit");
			host.child.kill("SIGKILL");
			await exited;
			expect(await liveSessionHolders(file, id)).toEqual([]);
			expect(await other.request({ type: "open_session", sessionPath: file })).toMatchObject({ success: true });
		} finally {
			await replacement.dispose();
		}
	} finally {
		await host.dispose();
	}
}, 60_000);

it.each(["", "   "])(
	"refuses a malformed expectedHostInstance with the sibling launch-profile string form",
	async (expectedHostInstance) => {
		const host = await startWorkerHost(undefined, { socket: true, sessionRuntime: "in-process" });
		try {
			const client = await host.connect();
			const refused = await client.request({
				type: "open_session",
				sessionPath: join(host.cwd, "malformed.jsonl"),
				expectedHostInstance,
			});
			expect(refused).toMatchObject({
				success: false,
				errorCode: "invalid_launch_profile: expectedHostInstance must be a non-empty string",
				errorData: { reason: "invalid_expected_host_instance", action: "supply_host_instance" },
			});
			expect((await client.request({ type: "list_sessions" })).data?.sessions).toEqual([]);
		} finally {
			await host.dispose();
		}
	},
	60_000,
);

it("writes a lease from a session worker with the host's process start, not the worker's own", async () => {
	const root = await mkdtemp(join(tmpdir(), "senpi-3255-worker-start-"));
	try {
		const file = join(root, "worker-held.jsonl");
		await persistSession(file, root);
		const durableId = "11111111-1111-4111-8111-111111111111";
		// The sentinel is far from any real boot instant, so the start a reverted
		// workerData pass-through would write (the worker isolate's own) can never
		// collide with the host value passed through workerData.
		const hostProcessStartedAtMs = 1_111_111_111_111;
		const worker = new Worker(new URL("./issue-3255-worker-start-fixture.mjs", import.meta.url), {
			workerData: { hostProcessStartedAtMs, file, id: durableId, cwd: root },
			execArgv: ["--import", "tsx"],
		});
		try {
			await once(worker, "message", { signal: AbortSignal.timeout(10_000) });
			const recordsDir = join(root, "session-holders", durableId);
			const records = (await readdir(recordsDir)).filter((name) => name.endsWith(".json"));
			expect(records).toHaveLength(1);
			const evidence = JSON.parse(await readFile(join(recordsDir, records[0]), "utf8"));
			expect(evidence.processStartedAtMs).toBe(hostProcessStartedAtMs);
		} finally {
			worker.postMessage("release");
			await once(worker, "exit", { signal: AbortSignal.timeout(10_000) });
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 30_000);
