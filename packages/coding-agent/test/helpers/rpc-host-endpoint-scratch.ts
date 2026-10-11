/**
 * Rig for the multi-endpoint suites: a temp agent directory holding a legacy socket and one `p` shard,
 * REAL supervised hosts ensured on them through the production lifecycle entry, and a teardown that
 * stops every host it started, removes a frozen supervisor's private hop directories, and reaps by
 * sandbox path before deleting it.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { shardSocketPath } from "../../src/modes/rpc/host-daemon-paths.ts";
import { type EnsuredHost, ensureHost } from "../../src/modes/rpc/host-ensure.ts";
import { STOP_WAIT_BUDGET_MS } from "../../src/modes/rpc/host-ensure-stop.ts";
import { settledOpportunisticHostGc } from "../../src/modes/rpc/host-gc-pass.ts";
import { runHostRequest } from "../../src/modes/rpc/host-runner.ts";
import type { HostEndpointStatus } from "../../src/modes/rpc/host-status-all.ts";
import { signalGeneration, stopHost } from "../../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	generationEnv,
	type HeldAnthropicModel,
	type JsonlPeer,
} from "./rpc-generation-support.ts";
import { writeRpcModelsJson } from "./rpc-hermetic.ts";
import { removeInternalDirs } from "./rpc-host-endpoints.ts";
import { reapProcessesUnder, waitForPidGone } from "./spawned-host-reaper.ts";

/** The owner of the scratch shard; its key is one of the fixed cross-repo vectors. */
export const SHARD_OWNER = "01a0e28d-40e4-7402-bac7-8de6e76ad84c";
export const SHARD_KEY = "6d410ba846ba1550";

export interface EndpointScratch {
	readonly root: string;
	readonly agentDir: string;
	readonly sessionDir: string;
	readonly cwd: string;
	readonly legacy: string;
	readonly shard: string;
}

const scratches: EndpointScratch[] = [];
const aliasTargets: string[] = [];
const ensured: { socket: string; agentDir: string }[] = [];
const supervisors: number[] = [];
const held: EnsuredHost[] = [];
export const tracked = { peers: [] as JsonlPeer[], models: [] as HeldAnthropicModel[], internalDirs: [] as string[] };

/**
 * The agent dir IS the temp root: `<root>/rpc/shards/p-<16hex>.sock` must fit in sun_path. With
 * `aliasedRoot` the root is a symlink under `/tmp` to the real directory, so its realpath differs on
 * every POSIX platform while a successor's `.next-<n>` bind still fits.
 */
export function endpointScratch(
	label: string,
	modelOrigin = "http://127.0.0.1:1",
	options: { readonly aliasedRoot?: boolean } = {},
): EndpointScratch {
	const root = options.aliasedRoot ? aliasedTempRoot(label) : mkdtempSync(join(tmpdir(), `sa-${label}-`));
	const qa = {
		root,
		agentDir: root,
		sessionDir: join(root, "s"),
		cwd: join(root, "w"),
		legacy: join(root, "rpc", "rpc.sock"),
		shard: shardSocketPath(join(root, "rpc", "shards"), "p", SHARD_OWNER),
	};
	scratches.push(qa);
	for (const dir of [qa.sessionDir, qa.cwd, dirname(qa.shard)]) mkdirSync(dir, { recursive: true });
	writeRpcModelsJson(qa.agentDir, modelOrigin);
	return qa;
}

export async function sweepEndpointScratches(): Promise<void> {
	for (const host of held.splice(0)) host.release();
	for (const peer of tracked.peers.splice(0)) peer.destroy();
	const models = tracked.models.splice(0);
	for (const model of models) model.release();
	for (const target of ensured.splice(0)) {
		const stopped = await stopHost({ ...target, force: true }).catch(() => undefined);
		if (stopped?.action === "stopped") await waitForPidGone(stopped.pid, STOP_WAIT_BUDGET_MS);
	}
	for (const pid of supervisors.splice(0)) {
		if (signalGeneration(pid, "SIGKILL")) await waitForPidGone(pid, 20_000);
	}
	for (const model of models) await model.close();
	await removeInternalDirs(tracked.internalDirs.splice(0));
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
	for (const target of aliasTargets.splice(0)) {
		await reapProcessesUnder(target);
		await rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}

function aliasedTempRoot(label: string): string {
	const target = mkdtempSync(join("/tmp", `sa-${label}-`));
	aliasTargets.push(target);
	const alias = `${target}-l`;
	symlinkSync(target, alias);
	return alias;
}

export function supervisorLaunch(args: readonly string[]): { command: string; args: string[] } {
	const entry = join(import.meta.dirname, "..", "..", "src", "modes", "rpc", "host-lifecycle.ts");
	return { command: process.execPath, args: [entry, ...args] };
}

export function hostEnv(qa: EndpointScratch): Record<string, string> {
	return generationEnv({ ...qa, socket: qa.legacy });
}

export function hostArgs(extension?: string): string[] {
	return [...GENERATION_HOST_ARGS, ...(extension ? ["--extension", extension] : [])];
}

type RealHostOptions = {
	idleExitMs?: number;
	/** Added to the host's environment, over `hostEnv(qa)`. */
	env?: Readonly<Record<string, string>>;
	extension?: string;
	afterLockAcquired?: () => Promise<void>;
	/** Return while the gc pass the ensure scheduled may still run; by default it has finished first. */
	gcPassInFlight?: boolean;
};

/** A real supervised host, released at once: the suite's own connections are what attach to it. */
export async function realHost(qa: EndpointScratch, socket: string, options: RealHostOptions = {}): Promise<number> {
	const host = await heldRealHost(qa, socket, options);
	host.release();
	return host.pid;
}

/** `realHost` that keeps the ensure's attach hold (senpi#2227): the caller releases it. */
export async function heldRealHost(
	qa: EndpointScratch,
	socket: string,
	options: RealHostOptions = {},
): Promise<EnsuredHost> {
	const host = await ensureHost({
		socket,
		agentDir: qa.agentDir,
		policy: { idleExitMs: options.idleExitMs ?? 600_000 },
		hostArgs: hostArgs(options.extension),
		env: { ...hostEnv(qa), ...options.env },
		_test: {
			readinessTimeoutMs: 60_000,
			launch: supervisorLaunch,
			...(options.afterLockAcquired && { afterLockAcquired: options.afterLockAcquired }),
		},
	});
	ensured.push({ socket, agentDir: qa.agentDir });
	supervisors.push(host.pid);
	held.push(host);
	// The pass may reap or record under the agent dir; a scenario's own steps start once it is done.
	if (options.gcPassInFlight !== true) await settledOpportunisticHostGc(qa.agentDir);
	return host;
}

export function trackSupervisor(pid: number): void {
	supervisors.push(pid);
}

export async function statusAll(qa: EndpointScratch, includeWorkers = false) {
	const outcome = await runHostRequest({
		action: "status",
		target: { socket: qa.legacy, agentDir: qa.agentDir },
		includeWorkers,
		all: true,
	});
	return { exitCode: outcome.exitCode, endpoints: outcome.payload.endpoints as readonly HostEndpointStatus[] };
}

export function endpointRow(endpoints: readonly HostEndpointStatus[], socket: string): HostEndpointStatus {
	const found = endpoints.find((endpoint) => endpoint.socket === socket);
	if (!found) throw new Error(`no --all row for ${socket}: ${JSON.stringify(endpoints.map((e) => e.socket))}`);
	return found;
}

export function hostChildren(supervisorPid: number): number[] {
	return execFileSync("pgrep", ["-P", String(supervisorPid)], { encoding: "utf8" })
		.split("\n")
		.map((line) => Number(line.trim()))
		.filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function canonicalSocket(socket: string): string {
	return join(realpathSync(dirname(socket)), basename(socket));
}
