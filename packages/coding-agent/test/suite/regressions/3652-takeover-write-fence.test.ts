import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { SessionFencedError, sessionFenceFile } from "../../../src/core/session-write-fence.ts";
import { hostDaemonDirectoryPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import {
	createSessionPathReservations,
	reservationFile,
	type SessionPathOwner,
} from "../../../src/modes/rpc/host-reservations.ts";

// #3652 review: a generation that only LOOKS done (its loop froze, its machine slept: the heartbeat stops either
// way) must not get a second writer on its session file. Taking the file over fences the old owner out: when it
// resumes, its writes are refused and the file is left exactly as the new owner keeps it.

const STALE_MS = 10 * 60_000;
let root: string;
let daemonDir: string;
let stalled: ReturnType<typeof spawn>;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "takeover-fence-"));
	daemonDir = join(root, "daemon");
	await mkdir(join(daemonDir, "reservations"), { recursive: true });
	stalled = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000_000)"], { stdio: "ignore" });
	await once(stalled, "spawn");
});

afterEach(async () => {
	const exited = once(stalled, "exit");
	stalled.kill();
	await exited;
	await rm(root, { recursive: true, force: true });
});

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

async function sessionClaimedByStalledGeneration(): Promise<{
	readonly writer: SessionManager;
	readonly sessionPath: string;
}> {
	const writer = SessionManager.create(root, join(root, "sessions"));
	writer.appendMessage(user("before the stall"));
	const sessionPath = writer.getSessionFile() as string;
	const claim: SessionPathOwner = {
		instanceId: "stalled",
		pid: stalled.pid as number,
		processStartTime: null,
		sessionPath,
		attached: true,
	};
	await writeFile(reservationFile(join(daemonDir, "reservations"), sessionPath), JSON.stringify(claim));
	const paths = hostDaemonDirectoryPaths(daemonDir);
	await mkdir(join(paths.generationsDir, "stalled"), { recursive: true });
	await writeFile(
		join(paths.generationsDir, "stalled", "host-alive.json"),
		JSON.stringify({ at: new Date(Date.now() - STALE_MS).toISOString() }),
	);
	await writeFile(paths.pointerFile, JSON.stringify({ instance_id: "current" }));
	return { writer, sessionPath };
}

it("refuses every write of a stalled-but-alive owner that resumes after its file was taken over", async () => {
	const { writer, sessionPath } = await sessionClaimedByStalledGeneration();
	const reservations = createSessionPathReservations({ daemonDir, instanceId: "current" });

	await expect(reservations.claim(sessionPath)).resolves.toBeUndefined();
	const successor = SessionManager.open(sessionPath);
	successor.appendMessage(user("written by the new owner"));
	const afterTakeover = readFileSync(sessionPath, "utf8");

	expect(() => writer.appendMessage(user("the stalled owner resumes"))).toThrow(SessionFencedError);
	expect(() => writer.appendMessage(user("and tries again"))).toThrow(SessionFencedError);
	expect(readFileSync(sessionPath, "utf8")).toBe(afterTakeover);

	successor.appendMessage(user("the new owner keeps writing"));
	expect(readFileSync(sessionPath, "utf8")).toContain("the new owner keeps writing");
	expect(readFileSync(sessionPath, "utf8")).not.toContain("the stalled owner resumes");
});

it("does not fence a session whose owner stands (its generation still heartbeats)", async () => {
	const { writer, sessionPath } = await sessionClaimedByStalledGeneration();
	await writeFile(
		join(hostDaemonDirectoryPaths(daemonDir).generationsDir, "stalled", "host-alive.json"),
		JSON.stringify({ at: new Date().toISOString() }),
	);
	const reservations = createSessionPathReservations({ daemonDir, instanceId: "current" });

	await expect(reservations.claim(sessionPath)).resolves.toMatchObject({ instanceId: "stalled" });
	expect(existsSync(sessionFenceFile(sessionPath))).toBe(false);
	writer.appendMessage(user("the owner keeps writing"));
	expect(readFileSync(sessionPath, "utf8")).toContain("the owner keeps writing");
});
