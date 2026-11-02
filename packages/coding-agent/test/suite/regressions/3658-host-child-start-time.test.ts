import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	createGenerationDirectory,
	generationPaths,
	type HostGenerationPaths,
	hostDaemonDirectoryPaths,
} from "../../../src/modes/rpc/host-daemon-paths.ts";
import { recordChildPid } from "../../../src/modes/rpc/host-lifecycle-scratch.ts";
import { hostChildAlive } from "../../../src/modes/rpc/host-stalled-evidence.ts";
import { writeJsonAtomic } from "../../../src/modes/rpc/host-state-json.ts";
import * as processIdentity from "../../../src/utils/process-identity.ts";

// #3658: on Windows the host child's start time was read once, with a 1 s CIM probe, right after spawn,
// so every `host-child.pid` recorded `null`. An unreadable child identity then preserved its generation
// forever: once the dead child's pid was reused, `host ensure` refused `host_stalled` indefinitely.
vi.mock("../../../src/utils/process-identity.ts", { spy: true });

const STALE_MS = 10 * 60_000;
let root: string;
let generation: HostGenerationPaths;
let stranger: ReturnType<typeof spawn>;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "host-child-start-time-"));
	generation = generationPaths(hostDaemonDirectoryPaths(root), "g1");
	await createGenerationDirectory(generation);
	// A live process: the host child, or the unrelated process that took its pid.
	stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000_000)"], { stdio: "ignore" });
	await once(stranger, "spawn");
});

afterEach(async () => {
	vi.resetAllMocks();
	const exited = once(stranger, "exit");
	stranger.kill();
	await exited;
	await rm(root, { recursive: true, force: true });
});

const starved = { kind: "error", error: new Error("probe timed out") } as const;

async function recorded(): Promise<{ pid: number; processStartTime: string | null }> {
	return JSON.parse(await readFile(generation.childPidFile, "utf8"));
}

async function heartbeat(ageMs: number): Promise<void> {
	await writeJsonAtomic(generation.aliveFile, { at: new Date(Date.now() - ageMs).toISOString() });
}

it("retries a starved identity probe and records the child's start time", async () => {
	vi.mocked(processIdentity.readProcessIdentity).mockResolvedValueOnce(starved).mockResolvedValueOnce(starved);
	await recordChildPid(generation.childPidFile, stranger.pid as number, () => true);
	const record = await recorded();
	expect(record.pid).toBe(stranger.pid);
	expect(typeof record.processStartTime).toBe("string");
	expect(processIdentity.processStartTimeMs(record.processStartTime as string)).toBeDefined();
});

it("never records an identity read after the child exited (its pid may already belong to another process)", async () => {
	await recordChildPid(generation.childPidFile, stranger.pid as number, () => false);
	expect(await recorded()).toEqual({ pid: stranger.pid, processStartTime: null });
});

it("releases a generation whose child identity was never recorded once its heartbeat stopped", async () => {
	await writeJsonAtomic(generation.childPidFile, { pid: stranger.pid, processStartTime: null });
	await heartbeat(STALE_MS);
	expect(await hostChildAlive(generation)).toBe(false);
});

it("releases a generation whose child identity cannot be read now once its heartbeat stopped", async () => {
	await writeJsonAtomic(generation.childPidFile, {
		pid: stranger.pid,
		processStartTime: new Date(Date.now() - STALE_MS).toISOString(),
	});
	await heartbeat(STALE_MS);
	vi.mocked(processIdentity.readProcessIdentity).mockResolvedValue(starved);
	expect(await hostChildAlive(generation)).toBe(false);
});

it("preserves an unproven child whose generation still heartbeats (a slow probe on a live host, #1609)", async () => {
	await writeJsonAtomic(generation.childPidFile, { pid: stranger.pid, processStartTime: null });
	await heartbeat(0);
	expect(await hostChildAlive(generation)).toBe(true);
});

it("preserves an unproven child whose generation left no heartbeat at all", async () => {
	await writeJsonAtomic(generation.childPidFile, { pid: stranger.pid, processStartTime: null });
	expect(await hostChildAlive(generation)).toBe(true);
});
