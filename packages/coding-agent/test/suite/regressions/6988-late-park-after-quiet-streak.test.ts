import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import {
	type HandoverParkedEntry,
	readHandoverParkedSessions,
	recordHandoverParkedSession,
} from "../../../src/modes/rpc/host-handover-parked.ts";
import { reopenHandoverParkedSessions } from "../../../src/modes/rpc/host-handover-reopen.ts";

// senpi#6988: a retained session still mid-turn when the predecessor's drain starts parks only after its turn settles,
// minutes after the successor bound. The successor's watch ended on the quiet streak (or the 120 s budget) and the park
// stayed on disk, so the session answered unknown_session by its durable id after an omo update.

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// No pid this large is ever live (Linux pid_max <= 2^22, macOS 99999), so the record names an exited process.
const EXITED_PID = 2_147_483_646;
const QUIET_STREAK_CHECKS = 16; // shouldReopen runs twice per pass; the watch reads eight empty passes as settled.

function generationRecord(agentDir: string, socket: string, instanceId: string, pid: number): void {
	const file = generationPaths(createHostDaemonPaths({ socket, agentDir }), instanceId).pidFile;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ pid, instance_id: instanceId }));
}

function parkFor(agentDir: string, name: string, id: string): HandoverParkedEntry {
	const sessionPath = join(agentDir, `${name}.jsonl`);
	const header = { type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd: agentDir };
	writeFileSync(sessionPath, `${JSON.stringify(header)}\n`, "utf8");
	return { sessionPath, durableSessionId: id, retainOnDisconnect: true, cwd: agentDir, parkedBy: "predecessor" };
}

it(
	"reopens a park that lands after the quiet streak while the predecessor is still draining",
	{ timeout: 30_000 },
	async () => {
		const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "late-park-")));
		dirs.push(agentDir);
		const socket = join(agentDir, "host.sock");
		const daemonDir = createHostDaemonPaths({ socket, agentDir }).dir;
		generationRecord(agentDir, socket, "predecessor", process.pid);
		// The successor's own live generation must not count as a predecessor, or the watch would never end.
		generationRecord(agentDir, socket, "successor", process.pid);
		const idle = parkFor(agentDir, "idle", "69880000-0000-4000-8000-000000000001");
		const busy = parkFor(agentDir, "busy", "69880000-0000-4000-8000-000000000002");
		await recordHandoverParkedSession(daemonDir, idle);

		const opened: string[] = [];
		let checks = 0;
		let latePark: Promise<void> | undefined;
		await reopenHandoverParkedSessions(
			async (entry) => {
				opened.push(entry.sessionPath);
				// The predecessor exits once its last turn settled and its park was taken.
				if (entry.sessionPath === busy.sessionPath) generationRecord(agentDir, socket, "predecessor", EXITED_PID);
			},
			agentDir,
			socket,
			{
				hostInstance: "successor",
				shouldReopen: () => {
					if (++checks === QUIET_STREAK_CHECKS) latePark = recordHandoverParkedSession(daemonDir, busy);
					return true;
				},
			},
		);
		await latePark;

		expect(opened).toEqual([idle.sessionPath, busy.sessionPath]);
		expect(await readHandoverParkedSessions(daemonDir)).toEqual([]);
	},
);
