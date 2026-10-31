import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { hostDaemonDirectoryPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import {
	createSessionPathReservations,
	reservationFile,
	type SessionPathOwner,
} from "../../../src/modes/rpc/host-reservations.ts";
import * as processIdentity from "../../../src/utils/process-identity.ts";

// #3652: on Windows a terminated generation's claim survives it, the OS hands its pid to an unrelated
// process, and the start-time probe cannot tell the two apart (null at publish time, or unreadable
// now). Such a claim used to stand forever. It now stands only while its generation still heartbeats.
vi.mock("../../../src/utils/process-identity.ts", { spy: true });

const STALE_MS = 10 * 60_000;
let root: string;
let daemonDir: string;
let sessionPath: string;
let stranger: ReturnType<typeof spawn>;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "unproven-claim-owner-"));
	daemonDir = join(root, "daemon");
	sessionPath = join(root, "session.jsonl");
	await mkdir(join(daemonDir, "reservations"), { recursive: true });
	// A live process that is NOT the generation that made the claim: the recycled pid.
	stranger = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000_000)"], { stdio: "ignore" });
	await once(stranger, "spawn");
});

afterEach(async () => {
	vi.restoreAllMocks();
	const exited = once(stranger, "exit");
	stranger.kill();
	await exited;
	await rm(root, { recursive: true, force: true });
});

async function publishClaim(owner: Partial<SessionPathOwner>): Promise<void> {
	const claim: SessionPathOwner = {
		instanceId: "dead",
		pid: stranger.pid as number,
		processStartTime: null,
		sessionPath,
		attached: true,
		...owner,
	};
	await writeFile(reservationFile(join(daemonDir, "reservations"), sessionPath), JSON.stringify(claim));
}

async function heartbeat(instanceId: string, ageMs: number): Promise<void> {
	const generation = join(hostDaemonDirectoryPaths(daemonDir).generationsDir, instanceId);
	await mkdir(generation, { recursive: true });
	await writeFile(
		join(generation, "host-alive.json"),
		JSON.stringify({ at: new Date(Date.now() - ageMs).toISOString() }),
	);
}

async function pointAt(instanceId: string): Promise<void> {
	await writeFile(hostDaemonDirectoryPaths(daemonDir).pointerFile, JSON.stringify({ instance_id: instanceId }));
}

async function claimAsCurrent() {
	return createSessionPathReservations({ daemonDir, instanceId: "current" }).claim(sessionPath);
}

it("reclaims a superseded claim with no recorded identity once its generation stopped heartbeating", async () => {
	await publishClaim({ processStartTime: null });
	await heartbeat("dead", STALE_MS);
	await pointAt("current");
	await expect(claimAsCurrent()).resolves.toBeUndefined();
});

it("reclaims a superseded claim whose recorded identity cannot be read now once its generation stopped heartbeating", async () => {
	await publishClaim({ processStartTime: new Date(Date.now() - STALE_MS).toISOString() });
	await heartbeat("dead", STALE_MS);
	await pointAt("current");
	vi.mocked(processIdentity.readProcessStartTime).mockRejectedValue(new Error("probe starved"));
	await expect(claimAsCurrent()).resolves.toBeUndefined();
});

it("keeps an unproven claim whose generation still heartbeats (a starved probe on a live host)", async () => {
	await publishClaim({ processStartTime: null });
	await heartbeat("dead", 0);
	await pointAt("current");
	await expect(claimAsCurrent()).resolves.toMatchObject({ instanceId: "dead", current: false });
});

it("keeps an unproven claim that carries no heartbeat evidence at all (unsupervised or legacy host)", async () => {
	await publishClaim({ processStartTime: null });
	await pointAt("current");
	await expect(claimAsCurrent()).resolves.toMatchObject({ instanceId: "dead", current: false });
});

it("keeps an unproven claim of the generation the pointer still names, whatever its heartbeat", async () => {
	await publishClaim({ processStartTime: null });
	await heartbeat("dead", STALE_MS);
	await pointAt("dead");
	await expect(claimAsCurrent()).resolves.toMatchObject({ instanceId: "dead", current: true });
});
