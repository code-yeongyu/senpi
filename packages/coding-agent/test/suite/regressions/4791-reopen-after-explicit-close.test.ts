// senpi#4791: a successor's handover-parked reopen watch never reopens a session whose park an explicit close_session
// cleared after the watch read the record; a park nobody closed is still reopened.
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import {
	readHandoverParkedSessions,
	recordHandoverParkedSession,
} from "../../../src/modes/rpc/host-handover-parked.ts";
import { reopenHandoverParkedSessions } from "../../../src/modes/rpc/host-handover-reopen.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function parkedRig() {
	const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "senpi-4791-")));
	dirs.push(agentDir);
	const socket = join(agentDir, "host.sock");
	const daemonDir = createHostDaemonPaths({ socket, agentDir }).dir;
	const sessionPath = join(agentDir, "retained.jsonl");
	await writeFile(
		sessionPath,
		`${JSON.stringify({ type: "session", version: 3, id: "47910000-0000-4000-8000-000000000001", timestamp: new Date(0).toISOString(), cwd: agentDir })}\n`,
		"utf8",
	);
	await recordHandoverParkedSession(daemonDir, {
		sessionPath,
		durableSessionId: "47910000-0000-4000-8000-000000000001",
		retainOnDisconnect: true,
		cwd: agentDir,
	});
	return { agentDir, socket, daemonDir, sessionPath };
}

it("does not reopen a park an explicit close cleared after the watch read the record", async () => {
	const { agentDir, socket, daemonDir } = await parkedRig();
	const parks = join(daemonDir, "handover-parked");
	const opened: string[] = [];
	let passes = 0;

	await reopenHandoverParkedSessions(
		async (entry) => {
			opened.push(entry.sessionPath);
		},
		agentDir,
		socket,
		{
			hostInstance: "successor",
			shouldReopen: () => passes++ === 0,
			// Called right after the watch read the record and before it opens what it read: an explicit close_session
			// of the same path clears the park in that window (as session-router-close does before finalizing).
			onProgress: (state) => {
				if (state === undefined || state.pending === 0) return;
				for (const name of readdirSync(parks)) rmSync(join(parks, name));
			},
		},
	);

	expect(opened).toEqual([]);
	expect(await readHandoverParkedSessions(daemonDir)).toEqual([]);
});

it("still reopens a park nobody closed", async () => {
	const { agentDir, socket, daemonDir, sessionPath } = await parkedRig();
	const opened: string[] = [];
	let passes = 0;

	await reopenHandoverParkedSessions(
		async (entry) => {
			opened.push(entry.sessionPath);
		},
		agentDir,
		socket,
		{ hostInstance: "successor", shouldReopen: () => passes++ < 2 },
	);

	expect(opened).toEqual([sessionPath]);
	expect(await readHandoverParkedSessions(daemonDir)).toEqual([]);
});
