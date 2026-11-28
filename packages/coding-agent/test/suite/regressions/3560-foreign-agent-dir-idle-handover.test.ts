// Regression for senpi issue #3560, idle-handover half: `senpi host handoff --when idle` asks the HOST to
// hand over (`begin_handover`), and the host runs the handoff with its own agent dir, so the generation
// handoff's agent-dir guard passes trivially there. A client of another agent dir must not get the host
// replaced by its runtime, launch command and environment: both halves refuse `foreign_agent_dir`, the
// CLI before it asks and the host when the request names another agent dir.
import { mkdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHostRequest } from "../../../src/modes/rpc/host-runner.ts";
import { readHostStatus } from "../../../src/modes/rpc/host-status.ts";
import { signalGeneration, stopHost } from "../../../src/modes/rpc/host-stop.ts";
import {
	type GenerationScratch,
	generationEnv,
	type JsonlPeer,
	processAlive,
	reapProcessesUnder,
	waitForPidGone,
} from "../../helpers/rpc-generation-support.ts";
import {
	beginHandoverCommand,
	connect,
	dataOf,
	type HandoverRig,
	startHandoverRig,
} from "../../helpers/rpc-idle-handover-support.ts";
import { probeSandboxHost } from "../../helpers/rpc-sandbox-host.ts";

const scratches: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];
const pids: number[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const pid of pids.splice(0)) if (signalGeneration(pid, "SIGKILL")) await waitForPidGone(pid, 20_000);
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

async function rig(label: string): Promise<HandoverRig> {
	const started = await startHandoverRig(label);
	scratches.push(started.qa);
	pids.push(started.firstPid);
	return started;
}

function foreignAgentDir(host: HandoverRig): string {
	const dir = join(host.qa.root, "other-agent");
	// The CLI checks this dir as a key root and refuses one writable by group or others (senpi#4541).
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

async function expectStillServing(host: HandoverRig): Promise<void> {
	const after = await probeSandboxHost(host.qa);
	expect(after?.instanceId).toBe(host.instanceId);
	expect(after?.runtimeBuildId).toBe(host.buildA.runtimeBuildId);
	expect(processAlive(host.firstPid)).toBe(true);
	const status = await readHostStatus({ socket: host.qa.socket, agentDir: host.qa.agentDir });
	expect(status.handover).toBeNull();
}

describe.skipIf(process.platform === "win32")("an idle handover asked by another agent directory (#3560)", () => {
	it("is refused by the host when the request names another agent dir", async () => {
		const host = await rig("ih-fa");
		const foreign = foreignAgentDir(host);
		const caller = await connect(host, peers);

		const answer = dataOf(await caller.request(beginHandoverCommand(host, { agent_dir: foreign }), 120_000));

		expect(answer).toMatchObject({ refused: "foreign_agent_dir" });
		expect(String(answer.detail)).toContain(realpathSync(host.qa.agentDir));
		expect(String(answer.detail)).toContain(realpathSync(foreign));
		await expectStillServing(host);
	}, 120_000);

	it("is refused by the CLI before it asks, and the same agent dir still hands over", async () => {
		const host = await rig("ih-fb");
		const foreign = foreignAgentDir(host);
		const spec = { hostArgs: host.buildB.hostArgs, policy: { idleExitMs: 600_000 }, env: generationEnv(host.qa) };
		const terms = {
			operationId: "op-foreign",
			ifInstanceId: host.instanceId,
			ifGeneration: host.generation,
			targetRuntimeBuildId: host.buildB.runtimeBuildId,
		};

		const refused = await runHostRequest({
			action: "handoff",
			target: { socket: host.qa.socket, agentDir: foreign },
			spec,
			handover: terms,
		});

		// omo#15197: this socket is outside the host's default layout, so no local evidence decides; the foreign agent
		// dir's key root cannot prove the host, and the dial is refused before anything is asked of it.
		expect(refused).toMatchObject({ exitCode: 3, payload: { reason: "host_identity_unproven" } });
		await expectStillServing(host);

		const own = await runHostRequest({
			action: "handoff",
			target: { socket: host.qa.socket, agentDir: host.qa.agentDir },
			spec,
			handover: { ...terms, operationId: "op-own" },
		});
		if (own.exitCode === 0 && typeof own.payload.pid === "number") pids.push(own.payload.pid);
		expect(own).toMatchObject({ exitCode: 0, payload: { action: "handover_completed" } });
		expect((await probeSandboxHost(host.qa))?.runtimeBuildId).toBe(host.buildB.runtimeBuildId);
	}, 180_000);

	// omo#15197: stop and status prove the host from the key root before they act. With the owner proven but no
	// key record for its launch under the key root in use, each answers a typed refusal (status: reachable, with the
	// refusal) and the host keeps serving. An empty SENPI_RPC_KEY_ROOT stands in for a root that lacks the record.
	it("answers stop and status for a host it cannot prove with a typed identity refusal", async () => {
		const host = await rig("ih-fc");
		const emptyRoot = foreignAgentDir(host);
		const target = { socket: host.qa.socket, agentDir: host.qa.agentDir };
		const saved = process.env.SENPI_RPC_KEY_ROOT;
		process.env.SENPI_RPC_KEY_ROOT = emptyRoot;
		try {
			const refused = { action: "refuse", reason: "host_identity_unproven" };
			expect(await stopHost({ ...target, force: true })).toMatchObject(refused);
			expect(await readHostStatus(target)).toMatchObject({
				reachable: true,
				refusal: { code: "host_identity_unproven" },
				lifecycle: null,
			});
		} finally {
			if (saved === undefined) delete process.env.SENPI_RPC_KEY_ROOT;
			else process.env.SENPI_RPC_KEY_ROOT = saved;
		}
		await expectStillServing(host);
	});
});
