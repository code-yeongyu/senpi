// Regression for senpi issue #3560: a client whose agent directory differs from the running host's
// replaced that host on its own socket. Such a client reads daemon state under ITS agent dir, finds no
// registration for the socket, and took the #2701 path that replaces an idle host nobody can prove - so a
// sandboxed dev server handed the user's real `~/.omo/agent/rpc/rpc.sock` to a sandbox host.
//
// Each host here is a REAL supervisor + host started through the production ensure for agent dir A on
// A's default socket. A handoff from agent dir B is refused `foreign_agent_dir` and the host keeps
// serving, unsignalled; a handoff from A itself (even through a symlinked path) still happens.
import { realpathSync } from "node:fs";
import { mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type EnsuredHost, ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { type HandoffResult, handoffHost } from "../../../src/modes/rpc/host-handoff.ts";
import { probeHost } from "../../../src/modes/rpc/host-probe.ts";
import { signalGeneration } from "../../../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	type GenerationScratch,
	generationEnv,
	generationScratch,
	processAlive,
	supervisorLaunch,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { reapProcessesUnder, waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

/** When set, every `get_protocol_info` answer this process reads loses `agentDir`: a host from before the field. */
const probe = vi.hoisted(() => ({ stripAgentDir: false }));

vi.mock("../../../src/modes/rpc/host-probe.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../../../src/modes/rpc/host-probe.ts")>();
	return {
		...original,
		probeProtocolInfo: async (...args: Parameters<typeof original.probeProtocolInfo>) => {
			const info = await original.probeProtocolInfo(...args);
			if (!probe.stripAgentDir || info === undefined) return info;
			const { agentDir: _agentDir, ...older } = info;
			return older;
		},
	};
});

const scratches: GenerationScratch[] = [];
const supervisors: number[] = [];
const releases: Array<() => void> = [];

afterEach(async () => {
	probe.stripAgentDir = false;
	vi.restoreAllMocks();
	for (const release of releases.splice(0)) release();
	for (const pid of supervisors.splice(0)) {
		if (!signalGeneration(pid, "SIGKILL")) continue;
		await waitForPidGone(pid, 20_000);
	}
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

interface LiveHost {
	readonly qa: GenerationScratch;
	readonly socket: string;
	readonly pid: number;
	readonly instanceId: string;
}

// A handoff renames sockets and drains with SIGUSR1; win32 has neither.
describe.skipIf(process.platform === "win32")("a handoff from another agent directory (#3560)", () => {
	it("is refused, naming both agent dirs, and the running host keeps serving unsignalled", async () => {
		const live = await startLiveHost("f3a");
		const foreign = scratch("f3b");
		const signals = watchSignals();

		const result = await handoffFrom(foreign.agentDir, live);

		expect(result).toMatchObject({ action: "refuse", reason: "foreign_agent_dir", upgradeable: false });
		const detail = result.action === "refuse" ? (result.detail ?? "") : "";
		expect(detail).toContain(realpathSync(live.qa.agentDir));
		expect(detail).toContain(realpathSync(foreign.agentDir));
		expect(signals.sentTo(live.pid)).toEqual([]);
		expect(processAlive(live.pid)).toBe(true);
		expect((await probeHost({ socket: live.socket, timeoutMs: 10_000 }))?.instanceId).toBe(live.instanceId);
	}, 240_000);

	it("is refused for a host that does not advertise its agent dir when its registration proves it", async () => {
		const live = await startLiveHost("f3c");
		const foreign = scratch("f3d");
		probe.stripAgentDir = true;
		const signals = watchSignals();

		const result = await handoffFrom(foreign.agentDir, live);

		expect(result).toMatchObject({ action: "refuse", reason: "foreign_agent_dir" });
		expect(result.action === "refuse" ? result.detail : undefined).toContain(realpathSync(live.qa.agentDir));
		expect(signals.sentTo(live.pid)).toEqual([]);
		expect((await probeHost({ socket: live.socket, timeoutMs: 10_000 }))?.instanceId).toBe(live.instanceId);
	}, 240_000);

	it("still hands off when the caller names the same agent dir through a symlink", async () => {
		const live = await startLiveHost("f3e");
		const alias = join(live.qa.root, "alias");
		await symlink(live.qa.agentDir, alias);

		const result = await handoffFrom(alias, live);

		if (result.action !== "handoff") throw new Error(`handoff refused: ${JSON.stringify(result)}`);
		expect(result.pid).not.toBe(live.pid);
		expect(await waitForPidGone(live.pid, 60_000)).toBe(true);
		expect((await probeHost({ socket: live.socket, timeoutMs: 10_000 }))?.instanceId).toBe(result.instanceId);
	}, 240_000);
});

function scratch(label: string): GenerationScratch {
	const qa = generationScratch(label);
	scratches.push(qa);
	return qa;
}

/** A registered, idle host for agent dir A on A's default socket - exactly what #2701 would replace. */
async function startLiveHost(label: string): Promise<LiveHost> {
	const qa = scratch(label);
	writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
	const socket = join(qa.agentDir, "rpc", "rpc.sock");
	await mkdir(join(qa.agentDir, "rpc"), { recursive: true });
	const ensured = await ensureOn(qa, socket);
	ensured.release();
	const instanceId = (await probeHost({ socket, timeoutMs: 10_000 }))?.instanceId;
	if (instanceId === undefined) throw new Error("the live host did not report an instanceId");
	return { qa, socket, pid: ensured.pid, instanceId };
}

async function handoffFrom(agentDir: string, live: LiveHost): Promise<HandoffResult> {
	const result = await handoffHost({
		socket: live.socket,
		agentDir,
		hostArgs: [...GENERATION_HOST_ARGS],
		env: generationEnv(live.qa),
		_test: { launch: supervisorLaunch, readinessTimeoutMs: 60_000 },
	});
	if (result.action === "handoff") supervisors.push(result.pid);
	return result;
}

async function ensureOn(qa: GenerationScratch, socket: string): Promise<EnsuredHost> {
	const ensured = await ensureHost({
		socket,
		agentDir: qa.agentDir,
		policy: { idleExitMs: 600_000 },
		hostArgs: [...GENERATION_HOST_ARGS],
		env: generationEnv(qa),
		_test: { readinessTimeoutMs: 60_000, stopTimeoutMs: 60_000, launch: supervisorLaunch },
	});
	supervisors.push(ensured.pid);
	releases.push(ensured.release);
	return ensured;
}

/** Records every signal this process delivers (the handoff runs in-process); signal 0 delivers nothing. */
function watchSignals(): { sentTo(pid: number): string[] } {
	const kill = vi.spyOn(process, "kill");
	return {
		sentTo: (pid) =>
			kill.mock.calls
				.filter(([target, signal]) => target === pid && signal !== 0)
				.map(([, signal]) => String(signal ?? "SIGTERM")),
	};
}
