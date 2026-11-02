// Regression for senpi issue #1893: a generation that lost the public socket stayed resident
// forever - retained sessions open at zero attachments, their cross-generation path claims still
// published, and nothing answering on the endpoint, so the CURRENT generation refused every reopen
// of those paths with `session_path_in_use`.
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { ensureHost } from "../../../src/modes/rpc/host-ensure.ts";
import { reservationFile } from "../../../src/modes/rpc/host-reservations.ts";
import { signalGeneration } from "../../../src/modes/rpc/host-stop.ts";
import {
	GENERATION_HOST_ARGS,
	type GenerationScratch,
	generationEnv,
	generationScratch,
	JsonlPeer,
	socketInode,
	supervisorLaunch,
} from "../../helpers/rpc-generation-support.ts";
import { writeRpcModelsJson } from "../../helpers/rpc-hermetic.ts";
import { reapProcessesUnder, waitForPidGone } from "../../helpers/spawned-host-reaper.ts";

const scratches: GenerationScratch[] = [];
const peers: JsonlPeer[] = [];
const servers: Server[] = [];
const supervisors: number[] = [];

afterEach(async () => {
	for (const peer of peers.splice(0)) peer.destroy();
	for (const pid of supervisors.splice(0)) {
		// Never `kill` on the strength of a liveness READ: a drained generation can exit between the
		// check and the signal, and the raw ESRCH would fail the hook for the very outcome under test.
		if (!signalGeneration(pid, "SIGKILL")) continue;
		await waitForPidGone(pid, 20_000);
	}
	for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
	for (const qa of scratches.splice(0)) {
		await reapProcessesUnder(qa.root);
		await rm(qa.root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
	}
}, 120_000);

// A generation is superseded by a rename over its public socket path and drains with SIGUSR1;
// win32 named pipes support neither, so this case is POSIX-only by construction.
describe.skipIf(process.platform === "win32")("a superseded generation", () => {
	it("parks its retained session, releases the claim, exits and leaves the endpoint alone", async () => {
		const qa = generationScratch("sup93");
		scratches.push(qa);
		writeRpcModelsJson(qa.agentDir, "http://127.0.0.1:1");
		const ensured = await ensureHost({
			socket: qa.socket,
			agentDir: qa.agentDir,
			// Long enough that only the supersession under test can end this generation.
			policy: { idleExitMs: 600_000 },
			hostArgs: [...GENERATION_HOST_ARGS],
			env: generationEnv(qa),
			_test: { readinessTimeoutMs: 60_000, launch: supervisorLaunch },
		});
		supervisors.push(ensured.pid);
		const sessionPath = join(realpathSync(qa.sessionDir), "superseded.jsonl");
		await writeFile(sessionPath, sessionHeader(qa.cwd), { mode: 0o600 });
		const client = await JsonlPeer.connect(qa.socket);
		peers.push(client);
		expect(
			await client.request({
				id: "open",
				type: "open_session",
				cwd: qa.cwd,
				sessionPath,
				retain_on_disconnect: true,
			}),
		).toMatchObject({ success: true, command: "open_session" });
		const reservations = createHostDaemonPaths({ socket: qa.socket, agentDir: qa.agentDir }).reservationsDir;
		expect(await claimFiles(reservations)).toEqual([basenameOf(reservationFile(reservations, sessionPath))]);
		// The client goes away: the session is retained, open at zero attachments, still claiming.
		client.destroy();

		// Another generation takes the public path without signalling this one - the incident's shape,
		// where three supervisors ended up bound to one socket and only the newest one answered.
		const successor = await takeSocket(qa.socket);

		expect(await waitForPidGone(ensured.pid, 90_000)).toBe(true);
		expect(await claimFiles(reservations)).toEqual([]);
		// The transcript was parked, not truncated: one writer leaves only whole records behind.
		expect(existsSync(sessionPath)).toBe(true);
		const lines = await jsonlLines(sessionPath);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) JSON.parse(line);
		// I1: the endpoint belongs to the successor now, and a drained generation never unlinks it.
		expect(await socketInode(qa.socket)).toBe(successor);
	}, 180_000);
});

function sessionHeader(cwd: string): string {
	return `${JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp: new Date(0).toISOString(), cwd })}\n`;
}

async function claimFiles(dir: string): Promise<string[]> {
	const entries = await readdir(dir).catch(() => [] as string[]);
	return entries.filter((entry) => entry.endsWith(".json")).sort();
}

function basenameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

async function jsonlLines(path: string): Promise<string[]> {
	return (await readFile(path, "utf8")).split("\n").filter((line) => line.length > 0);
}

/** Replaces the public socket with a server this daemon never started; returns its inode. */
async function takeSocket(socketPath: string): Promise<number | undefined> {
	await rm(socketPath, { force: true });
	const successor = createServer((socket) => socket.end());
	servers.push(successor);
	await new Promise<void>((resolve) => successor.listen(socketPath, resolve));
	return (await stat(socketPath)).ino;
}
