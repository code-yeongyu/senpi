import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { parseHostArgs } from "../src/cli/host-command.ts";
import { probeHost } from "../src/modes/rpc/host-probe.ts";
import { runHostRequest } from "../src/modes/rpc/host-runner.ts";
import { readHostStatus } from "../src/modes/rpc/host-status.ts";
import { signalGeneration } from "../src/modes/rpc/host-stop.ts";
import {
	type GenerationScratch,
	generationEnv,
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
	failingLaunch,
	type HandoverRig,
	startHandoverRig,
} from "./helpers/rpc-idle-handover-support.ts";

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

async function rig(label: string, modelOrigin?: string): Promise<HandoverRig> {
	const started = await startHandoverRig(label, modelOrigin);
	scratches.push(started.qa);
	pids.push(started.firstPid);
	return started;
}

describe("host handoff --when idle arguments", () => {
	const terms = [
		"--when",
		"idle",
		"--operation",
		"op",
		"--if-instance",
		"i",
		"--target-build",
		`sha256:${"b".repeat(64)}`,
	];

	it("reads the terms of a conditional handover", () => {
		expect(parseHostArgs(["handoff", ...terms, "--if-generation", "3"])).toMatchObject({
			handover: { operationId: "op", ifInstanceId: "i", ifGeneration: 3 },
		});
	});

	it("refuses a generation it cannot represent exactly and incomplete terms", () => {
		expect(parseHostArgs(["handoff", ...terms, "--if-generation", "9007199254740993"])).toContain("--if-generation");
		expect(parseHostArgs(["handoff", "--when", "idle", "--operation", "op"])).toContain("needs --operation");
		expect(parseHostArgs(["handoff", ...terms.slice(2), "--if-generation", "1", "--when", "later"])).toContain(
			"only --when idle",
		);
	});
});

describe.skipIf(process.platform === "win32")("conditional idle handover refusals", () => {
	it("leaves the predecessor serving and admitting work when the successor never comes up", async () => {
		const held = await HeldAnthropicModel.start();
		models.push(held);
		const host = await rig("ih-fail", held.origin);
		const caller = await connect(host, peers);

		const answer = dataOf(await caller.request(beginHandoverCommand(host, { launch: failingLaunch() }), 120_000));

		expect(answer).toMatchObject({ operation_id: "op-1", state: "handover_blocked" });
		expect(String(answer.reason)).toContain("successor_unavailable");
		const after = await probeHost({ socket: host.qa.socket });
		expect(after?.instanceId).toBe(host.instanceId);
		expect(after?.runtimeBuildId).toBe(host.buildA.runtimeBuildId);
		expect(processAlive(host.firstPid)).toBe(true);
		const status = await readHostStatus({ socket: host.qa.socket, agentDir: host.qa.agentDir });
		expect(status.handover).toMatchObject({ state: "handover_blocked" });
		const sessionId = openedSessionId(await caller.request({ id: "open", type: "open_session", cwd: host.qa.cwd }));
		const started = caller.waitFor((record) => record.type === "agent_start" && record.sessionId === sessionId);
		expect(await caller.request({ id: "p", type: "prompt", sessionId, message: "still served" })).toMatchObject({
			success: true,
		});
		await started;
		held.release();
	}, 180_000);

	it("keeps serving when the launched successor does not run the requested runtime", async () => {
		const host = await rig("ih-wrongbuild");
		const caller = await connect(host, peers);
		const changed = `sha256:${"a".repeat(64)}`;

		const answer = dataOf(
			await caller.request(beginHandoverCommand(host, { target_runtime_build_id: changed }), 120_000),
		);

		expect(answer).toMatchObject({ operation_id: "op-1", state: "handover_blocked" });
		const after = await probeHost({ socket: host.qa.socket });
		expect(after?.instanceId).toBe(host.instanceId);
		expect(after?.runtimeBuildId).toBe(host.buildA.runtimeBuildId);
		expect(processAlive(host.firstPid)).toBe(true);
	}, 180_000);

	it("answers a repeated operation id with the operation that already exists", async () => {
		const held = await HeldAnthropicModel.start();
		models.push(held);
		const host = await rig("ih-repeat", held.origin);
		const worker = await connect(host, peers);
		const busy = openedSessionId(await worker.request({ id: "open", type: "open_session", cwd: host.qa.cwd }));
		const started = worker.waitFor((record) => record.type === "agent_start" && record.sessionId === busy);
		await worker.request({ id: "prompt", type: "prompt", sessionId: busy, message: "hold" });
		await started;

		const first = dataOf(await (await connect(host, peers)).request(beginHandoverCommand(host)));
		const again = dataOf(await (await connect(host, peers)).request(beginHandoverCommand(host)));
		const other = dataOf(
			await (await connect(host, peers)).request(
				beginHandoverCommand(host, { operation_id: "op-2", target_runtime_build_id: `sha256:${"0".repeat(64)}` }),
			),
		);

		expect(first).toMatchObject({ operation_id: "op-1", state: "handover_pending" });
		expect(again).toEqual(first);
		const conflicting = dataOf(
			await (await connect(host, peers)).request(beginHandoverCommand(host, { if_generation: host.generation + 1 })),
		);
		const joined = dataOf(
			await (await connect(host, peers)).request(beginHandoverCommand(host, { operation_id: "op-3" })),
		);
		expect(conflicting).toMatchObject({ refused: "operation_conflict" });
		expect(joined).toMatchObject({ operation_id: "op-1", state: "handover_pending" });
		expect(other).toMatchObject({ refused: "handover_in_progress", detail: "op-1" });
		const status = await readHostStatus({ socket: host.qa.socket, agentDir: host.qa.agentDir });
		expect(status.instanceId).toBe(host.instanceId);
		expect(status.generations.filter((row) => row.alive)).toHaveLength(1);
	}, 180_000);

	it("refuses a request about another generation and keeps admitting work", async () => {
		const host = await rig("ih-stale");
		const caller = await connect(host, peers);

		const answer = dataOf(await caller.request(beginHandoverCommand(host, { if_generation: host.generation + 1 })));

		expect(answer).toMatchObject({ refused: "stale_generation" });
		const status = await readHostStatus({ socket: host.qa.socket, agentDir: host.qa.agentDir });
		expect(status.handover).toBeNull();
		expect(status.instanceId).toBe(host.instanceId);
	}, 120_000);

	it("refuses from the CLI when the target is not the runtime this CLI would launch", async () => {
		const host = await rig("ih-cli");
		const target = { socket: host.qa.socket, agentDir: host.qa.agentDir };
		const spec = { hostArgs: host.buildA.hostArgs, policy: { idleExitMs: 600_000 }, env: generationEnv(host.qa) };
		const terms = {
			operationId: "op-cli",
			ifInstanceId: host.instanceId,
			ifGeneration: host.generation,
			targetRuntimeBuildId: host.buildB.runtimeBuildId,
		};

		const mismatch = await runHostRequest({ action: "handoff", target, spec, handover: terms });
		const stale = await runHostRequest({
			action: "handoff",
			target,
			spec: { ...spec, hostArgs: host.buildB.hostArgs },
			handover: { ...terms, ifInstanceId: "another-instance" },
		});
		const current = await runHostRequest({
			action: "handoff",
			target,
			spec,
			handover: { ...terms, targetRuntimeBuildId: host.buildA.runtimeBuildId },
		});

		expect(mismatch).toMatchObject({ exitCode: 3, payload: { reason: "target_build_mismatch" } });
		expect(stale).toMatchObject({ exitCode: 3, payload: { reason: "stale_generation" } });
		expect(current).toMatchObject({
			exitCode: 0,
			payload: { action: "handover_completed", runtimeBuildId: host.buildA.runtimeBuildId },
		});
		expect((await probeHost({ socket: host.qa.socket }))?.instanceId).toBe(host.instanceId);
	}, 120_000);
});
