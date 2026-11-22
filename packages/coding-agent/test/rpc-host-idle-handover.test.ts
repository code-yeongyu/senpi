import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
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
import { beginHandoverCommand, connect, dataOf, startHandoverRig } from "./helpers/rpc-idle-handover-support.ts";

const scratches: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];
const models: HeldAnthropicModel[] = [];
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

describe.skipIf(process.platform === "win32")("conditional idle handover between runtimes", () => {
	it("reports the runtime it loaded and hands over at once when it holds no session", async () => {
		const rig = await startHandoverRig("ih-empty");
		scratches.push(rig.qa);
		pids.push(rig.firstPid);
		const before = await readHostStatus({ socket: rig.qa.socket, agentDir: rig.qa.agentDir });
		expect(before.runtimeBuildId).toBe(rig.buildA.runtimeBuildId);
		expect(before.capabilities).toContain("runtime_identity_handover");

		const caller = await connect(rig, peers);
		const answer = dataOf(await caller.request(beginHandoverCommand(rig), 120_000));

		expect(answer).toMatchObject({ operation_id: "op-1", state: "handover_completed" });
		const successor = answer.successor as { pid: number; runtimeBuildId: string };
		pids.push(successor.pid);
		expect(successor.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
		const after = await probeHost({ socket: rig.qa.socket });
		expect(after?.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
		expect(after?.instanceId).not.toBe(rig.instanceId);
		expect(await waitForPidGone(rig.firstPid, 45_000)).toBe(true);
	}, 180_000);

	it("waits for a running turn, admits no new one and hands over once the turn ends", async () => {
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
		const answer = dataOf(await caller.request(beginHandoverCommand(rig)));
		expect(answer).toMatchObject({ operation_id: "op-1", state: "handover_pending" });

		const pending = await readHostStatus({ socket: rig.qa.socket, agentDir: rig.qa.agentDir });
		expect(pending.instanceId).toBe(rig.instanceId);
		expect(pending.handover).toMatchObject({ operation_id: "op-1", state: "handover_pending" });
		const refused = await worker.request({ id: "new-turn", type: "prompt", sessionId: idle, message: "new work" });
		expect(refused).toMatchObject({ success: false, error: expect.stringContaining("handover_pending") });
		expect(processAlive(rig.firstPid)).toBe(true);
		expect((await probeHost({ socket: rig.qa.socket }))?.runtimeBuildId).toBe(rig.buildA.runtimeBuildId);

		const turnEnded = worker.waitFor((record) => record.type === "agent_end" && record.sessionId === busy, 60_000);
		const superseded = worker.waitFor((record) => record.type === "host_superseded", 120_000);
		held.release();
		expect(await turnEnded).toMatchObject({ type: "agent_end" });
		await superseded;
		const after = await probeHost({ socket: rig.qa.socket });
		expect(after?.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
		expect(await waitForPidGone(rig.firstPid, 60_000)).toBe(true);
		const status = await readHostStatus({ socket: rig.qa.socket, agentDir: rig.qa.agentDir });
		const current = status.generations.find((row) => row.current);
		if (current !== undefined) pids.push(current.pid);
		expect(status.runtimeBuildId).toBe(rig.buildB.runtimeBuildId);
	}, 240_000);
});
