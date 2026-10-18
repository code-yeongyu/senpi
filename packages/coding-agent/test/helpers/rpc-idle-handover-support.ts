/**
 * Rig for the conditional idle handover: a real supervised host on one runtime ("build A"), a
 * second runtime ("build B") that differs only in its plugin's contents, and the `begin_handover`
 * request a CLI of build B would send. Both builds run the same engine source, so the ONLY thing
 * that tells them apart is the content digest - which is the point of `runtimeBuildId`.
 */
import { writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { daemonEnvironment } from "../../src/modes/rpc/host-daemon-env.ts";
import { ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { probeHost } from "../../src/modes/rpc/host-probe.ts";
import { socketHostLaunchProfile } from "../../src/modes/rpc/protocol-identity.ts";
import { computeRuntimeBuildId } from "../../src/modes/rpc/runtime-build-id.ts";
import {
	GENERATION_HOST_ARGS,
	type GenerationScratch,
	generationEnv,
	generationScratch,
	JsonlPeer,
	reapProcessesUnder,
	supervisorLaunch,
	type WireRecord,
} from "./rpc-generation-support.ts";
import { writeRpcModelsJson } from "./rpc-hermetic.ts";

export interface HandoverBuild {
	readonly hostArgs: readonly string[];
	readonly runtimeBuildId: string;
}

export interface HandoverRig {
	readonly qa: GenerationScratch;
	readonly firstPid: number;
	readonly instanceId: string;
	readonly generation: number;
	readonly buildA: HandoverBuild;
	readonly buildB: HandoverBuild;
}

/** A plugin of one build: same behavior in both, different bytes. */
function pluginBuild(qa: GenerationScratch, name: string): readonly string[] {
	const path = join(qa.root, `${name}.js`);
	writeFileSync(path, `// plugin ${name}\nexport default function plugin() {}\n`);
	return [...GENERATION_HOST_ARGS, "--extension", path];
}

async function describeBuild(hostArgs: readonly string[]): Promise<HandoverBuild> {
	const profile = socketHostLaunchProfile(hostArgs, process.cwd());
	return { hostArgs, runtimeBuildId: await computeRuntimeBuildId({ profile: profile.core }) };
}

export async function startHandoverRig(label: string, modelOrigin?: string): Promise<HandoverRig> {
	const qa = generationScratch(label);
	try {
		return await startRigIn(qa, modelOrigin);
	} catch (error) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
		throw error;
	}
}

async function startRigIn(qa: GenerationScratch, modelOrigin: string | undefined): Promise<HandoverRig> {
	writeRpcModelsJson(qa.agentDir, modelOrigin ?? "http://127.0.0.1:1");
	const buildA = await describeBuild(pluginBuild(qa, "build-a"));
	const buildB = await describeBuild(pluginBuild(qa, "build-b"));
	const ensured = await ensureHost({
		socket: qa.socket,
		agentDir: qa.agentDir,
		policy: { idleExitMs: 600_000 },
		hostArgs: [...buildA.hostArgs],
		env: generationEnv(qa),
		_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
	});
	const host = await probeHost({ socket: qa.socket });
	if (host?.instanceId === undefined || host.generation === undefined) throw new Error("build A did not answer");
	return { qa, firstPid: ensured.pid, instanceId: host.instanceId, generation: host.generation, buildA, buildB };
}

/** The request a CLI of build B sends; `overrides` replaces any field, `launch` the successor's command. */
export function beginHandoverCommand(rig: HandoverRig, overrides: WireRecord = {}): WireRecord {
	const env: Record<string, string> = {};
	for (const [name, value] of Object.entries(daemonEnvironment(process.env, generationEnv(rig.qa)))) {
		if (value !== undefined) env[name] = value;
	}
	const launch = supervisorLaunch([]);
	return {
		id: "begin",
		type: "begin_handover",
		operation_id: "op-1",
		if_instance_id: rig.instanceId,
		if_generation: rig.generation,
		target_runtime_build_id: rig.buildB.runtimeBuildId,
		launch: { command: launch.command, args: launch.args },
		host_args: rig.buildB.hostArgs,
		env,
		policy: { idleExitMs: 600_000 },
		...overrides,
	};
}

/** A launch whose successor exits at once: the readiness the handoff waits for never comes. */
export function failingLaunch(): WireRecord {
	return { command: process.execPath, args: ["-e", "process.exit(1)"] };
}

export async function connect(rig: HandoverRig, peers: JsonlPeer[]): Promise<JsonlPeer> {
	const peer = await JsonlPeer.connect(rig.qa.socket);
	peers.push(peer);
	return peer;
}

export function dataOf(response: WireRecord): WireRecord {
	return (response.data ?? {}) as WireRecord;
}
