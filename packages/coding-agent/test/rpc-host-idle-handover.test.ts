import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
	GENERATION_SEPARATED_ADMISSION_CAPABILITY,
	SESSION_TRANSFER_RECONCILIATION_CAPABILITY,
} from "../src/modes/rpc/host-handover-eligibility.ts";
import { OVERLAP_HANDOVER_ENV } from "../src/modes/rpc/host-idle-handover.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { readHostStatus } from "../src/modes/rpc/host-status.ts";
import { signalGeneration } from "../src/modes/rpc/host-stop.ts";
import {
	type GenerationScratch,
	HeldAnthropicModel,
	type JsonlPeer,
	openedSessionId,
	processAlive,
	reapProcessesUnder,
	waitForPidGone,
} from "./helpers/rpc-generation-support.ts";
import {
	beginHandoverCommand,
	connect,
	dataOf,
	startHandoverRig,
	startSelectiveHoldModel,
} from "./helpers/rpc-idle-handover-support.ts";

const scratches: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];
const models: Array<{ release(): void; close(): Promise<void> }> = [];
const pids: number[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const model of models.splice(0)) {
		model.release();
		await model.close();
	}
	for (const pid of pids.splice(0)) if (signalGeneration(pid, "SIGKILL")) await waitForPidGone(pid, 20_000);
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

describe.skipIf(process.platform === "win32")("runtime-identity handover between runtimes", () => {
	it("reports the runtime it loaded and hands over at once when it holds no session", async () => {
		const rig = await startHandoverRig("ih-empty");
		scratches.push(rig.qa);
		pids.push(rig.firstPid);
		const before = await readHostStatus({ socket: rig.qa.socket, agentDir: rig.qa.agentDir });
		expect(before.runtimeBuildId).toBe(rig.buildA.runtimeBuildId);
		expect(before.capabilities).toContain("runtime_identity_handover");
		expect(before.capabilities).toContain("strict_session_transfer_v1");

		const caller = await connect(rig, peers);
		const answer = dataOf(await caller.request(beginHandoverCommand(rig), 120_000));

		expect(answer).toMatchObject({ operation_id: "op-1", state: "handover_completed", phase: "draining" });
		const successor = answer.successor as { pid: number; runtimeBuildId: string };
		pids.push(successor.pid);
		expect(successor.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
		const after = await probeHost({ socket: rig.qa.socket });
		expect(after?.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
		expect(after?.instanceId).not.toBe(rig.instanceId);
		expect(await waitForPidGone(rig.firstPid, 45_000)).toBe(true);
	}, 180_000);

	// code-yeongyu/oh-my-openagent#10091: the handover used to refuse every new prompt on this host until the
	// running turn ended. An overlapping update the endpoint did not opt in to is deferred at once instead, and
	// new work keeps reaching this host.
	it("defers an overlapping update at once while a turn runs and keeps admitting new work", async () => {
		const held = await HeldAnthropicModel.start();
		models.push(held);
		const rig = await startHandoverRig("ih-held", held.origin);
		scratches.push(rig.qa);
		pids.push(rig.firstPid);
		const worker = await connect(rig, peers);
		const busy = openedSessionId(await worker.request({ id: "open", type: "open_session", cwd: rig.qa.cwd }));
		const started = worker.waitFor((record) => record.type === "agent_start" && record.sessionId === busy);
		await worker.request({ id: "prompt", type: "prompt", sessionId: busy, message: "hold this turn" });
		await started;
		const idle = openedSessionId(await worker.request({ id: "open-2", type: "open_session", cwd: rig.qa.cwd }));

		const caller = await connect(rig, peers);
		const answer = dataOf(await caller.request(beginHandoverCommand(rig), 120_000));

		expect(answer).toMatchObject({
			operation_id: "op-1",
			phase: "migration_deferred",
			state: "handover_blocked",
			reason: "rollout_disabled",
		});
		const admitted = worker.waitFor((record) => record.type === "agent_start" && record.sessionId === idle);
		expect(
			await worker.request({ id: "new-turn", type: "prompt", sessionId: idle, message: "new work" }),
		).toMatchObject({ success: true });
		await admitted;
		expect((await probeHost({ socket: rig.qa.socket }))?.instanceId).toBe(rig.instanceId);
		expect(processAlive(rig.firstPid)).toBe(true);
	}, 240_000);

	// code-yeongyu/oh-my-openagent#10091 (availability): with the endpoint opted in and every application client
	// able to follow it, the successor serves new sessions at once while the old turns stay held on their owner.
	it("publishes the successor for a new session while two old turns stay held on their owner", async () => {
		const model = await startSelectiveHoldModel("hold-turn-10091");
		models.push(model);
		const rig = await startHandoverRig("ih-overlap", model.origin, { [OVERLAP_HANDOVER_ENV]: "1" });
		scratches.push(rig.qa);
		pids.push(rig.firstPid);
		const worker = await connect(rig, peers);
		await worker.request({
			id: "caps",
			type: "set_client_info",
			width: 80,
			capabilities: [GENERATION_SEPARATED_ADMISSION_CAPABILITY, SESSION_TRANSFER_RECONCILIATION_CAPABILITY],
		});
		const old: string[] = [];
		for (const name of ["a", "b"]) {
			const sessionId = openedSessionId(
				await worker.request({ id: `open-${name}`, type: "open_session", cwd: rig.qa.cwd }),
			);
			const started = worker.waitFor((record) => record.type === "agent_start" && record.sessionId === sessionId);
			await worker.request({ id: `prompt-${name}`, type: "prompt", sessionId, message: `hold-turn-10091 ${name}` });
			await started;
			old.push(sessionId);
		}

		const caller = await connect(rig, peers);
		const answer = dataOf(await caller.request(beginHandoverCommand(rig), 120_000));

		expect(answer).toMatchObject({ operation_id: "op-1", phase: "draining", state: "handover_completed" });
		pids.push((answer.successor as { pid: number }).pid);
		const fresh = await connect(rig, peers);
		const freshSession = openedSessionId(
			await fresh.request({ id: "open-c", type: "open_session", cwd: rig.qa.cwd }),
		);
		const ended = fresh.waitFor((record) => record.type === "agent_end" && record.sessionId === freshSession, 60_000);
		await fresh.request({ id: "prompt-c", type: "prompt", sessionId: freshSession, message: "quick" });
		await ended;
		expect((await probeHost({ socket: rig.qa.socket }))?.instanceId).not.toBe(rig.instanceId);
		const listed = await worker.request({ id: "list", type: "list_sessions" });
		const owned = ((listed.data as { sessions?: Array<{ sessionId: string }> }).sessions ?? []).map(
			(row) => row.sessionId,
		);
		expect(owned).toEqual(expect.arrayContaining(old));
		expect(processAlive(rig.firstPid)).toBe(true);

		model.release();
		expect(await waitForPidGone(rig.firstPid, 60_000)).toBe(true);
	}, 240_000);
});
