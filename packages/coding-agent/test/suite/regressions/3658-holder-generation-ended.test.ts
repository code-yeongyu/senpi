import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	createGenerationDirectory,
	generationPaths,
	HOST_DAEMON_DIR_ENV,
	hostDaemonDirectoryPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { HOST_INSTANCE_ID_ENV } from "../../../src/modes/rpc/host-identity-env.ts";
import { holderGenerationEnded } from "../../../src/modes/rpc/host-stalled-evidence.ts";
import { writeJsonAtomic } from "../../../src/modes/rpc/host-state-json.ts";
import { createInProcessRig } from "../rpc-inprocess-host-support.ts";

// #3658, third layer: what proves that the host generation behind a session-holder lease has ended, when
// the lease's pid is alive but its start time cannot be compared (desktop#3157, run 39166325038).
const STALE_MS = 10 * 60_000;
let daemonDir: string;

beforeEach(async () => {
	daemonDir = await mkdtemp(join(tmpdir(), "holder-generation-"));
	await writeFile(join(daemonDir, "endpoint.json"), JSON.stringify({ layout: 2, socket: "s" }));
});

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await rm(daemonDir, { recursive: true, force: true });
});

async function generationWithHeartbeat(instance: string, ageMs?: number): Promise<void> {
	const generation = generationPaths(hostDaemonDirectoryPaths(daemonDir), instance);
	await createGenerationDirectory(generation);
	if (ageMs !== undefined)
		await writeJsonAtomic(generation.aliveFile, { at: new Date(Date.now() - ageMs).toISOString() });
}

it("has ended once its generation's heartbeat stopped", async () => {
	await generationWithHeartbeat("dead", STALE_MS);
	expect(await holderGenerationEnded({ host_instance: "dead", host_daemon_dir: daemonDir })).toBe(true);
});

it("has not ended while its generation still heartbeats (a live host with a slow probe, #1609)", async () => {
	await generationWithHeartbeat("live", 0);
	expect(await holderGenerationEnded({ host_instance: "live", host_daemon_dir: daemonDir })).toBe(false);
});

it("has not ended when its generation left no heartbeat at all", async () => {
	await generationWithHeartbeat("quiet");
	expect(await holderGenerationEnded({ host_instance: "quiet", host_daemon_dir: daemonDir })).toBe(false);
});

it("has ended once its daemon released the generation directory", async () => {
	expect(await holderGenerationEnded({ host_instance: "released", host_daemon_dir: daemonDir })).toBe(true);
});

it("proves nothing when the named daemon directory is not an endpoint's", async () => {
	await rm(join(daemonDir, "endpoint.json"));
	expect(await holderGenerationEnded({ host_instance: "released", host_daemon_dir: daemonDir })).toBe(false);
});

it("reads a lease without a daemon directory against this host's own daemon, by heartbeat only", async () => {
	vi.stubEnv(HOST_DAEMON_DIR_ENV, daemonDir);
	await generationWithHeartbeat("dead", STALE_MS);
	expect(await holderGenerationEnded({ host_instance: "dead" })).toBe(true);
	expect(await holderGenerationEnded({ host_instance: "elsewhere" })).toBe(false);
});

it("never ends this host's own generation or one named by an unsafe id", async () => {
	vi.stubEnv(HOST_INSTANCE_ID_ENV, "self");
	await generationWithHeartbeat("self", STALE_MS);
	expect(await holderGenerationEnded({ host_instance: "self", host_daemon_dir: daemonDir })).toBe(false);
	expect(await holderGenerationEnded({ host_instance: "../x", host_daemon_dir: daemonDir })).toBe(false);
	expect(await holderGenerationEnded({ host_instance: "dead", host_daemon_dir: "relative/dir" })).toBe(false);
	expect(await holderGenerationEnded({ host_daemon_dir: daemonDir })).toBe(false);
});

it("records the daemon directory in the holder lease of a supervised host", async () => {
	vi.stubEnv(HOST_DAEMON_DIR_ENV, daemonDir);
	await using rig = createInProcessRig(daemonDir);
	const openSession = vi.spyOn(rig.registry, "openSession");
	await rig.open("client", { sessionPath: join(daemonDir, "session.jsonl") });
	expect(openSession.mock.calls[0]?.[0].holderEndpoint).toMatchObject({ host_daemon_dir: daemonDir });
});
