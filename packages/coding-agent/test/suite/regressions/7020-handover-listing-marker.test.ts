import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createHostDaemonPaths, generationPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import { type HandoverParkedEntry, recordHandoverParkedSession } from "../../../src/modes/rpc/host-handover-parked.ts";
import { type InheritedHandover, reopenHandoverParkedSessions } from "../../../src/modes/rpc/host-handover-reopen.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { evictionRegistry, idleEntry } from "../rpc-host-observer-support.ts";

// senpi#7020: right after a handoff the successor answers list_sessions before it has reopened the sessions its
// predecessor holds or parked (0, then a partial set, for ~1.5 s on an idle host, minutes on a loaded one). A reader
// cannot tell that from a host whose sessions are gone. The reopen watch reports what it is still taking over, so the
// listing can say so.

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

// No pid this large is ever live (Linux pid_max <= 2^22, macOS 99999), so the record names an exited process.
const EXITED_PID = 2_147_483_646;

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

it("reports the parks it has not reopened and a draining predecessor while it takes over, and nothing once done", async () => {
	const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "handover-marker-")));
	dirs.push(agentDir);
	const socket = join(agentDir, "host.sock");
	const daemonDir = createHostDaemonPaths({ socket, agentDir }).dir;
	generationRecord(agentDir, socket, "predecessor", process.pid);
	generationRecord(agentDir, socket, "successor", process.pid);
	const first = parkFor(agentDir, "first", "70200000-0000-4000-8000-000000000001");
	const second = parkFor(agentDir, "second", "70200000-0000-4000-8000-000000000002");
	await recordHandoverParkedSession(daemonDir, first);
	await recordHandoverParkedSession(daemonDir, second);

	const seen: (InheritedHandover | undefined)[] = [];
	let progress: InheritedHandover | undefined;
	await reopenHandoverParkedSessions(
		async (entry) => {
			seen.push(progress);
			if (entry.sessionPath === second.sessionPath) generationRecord(agentDir, socket, "predecessor", EXITED_PID);
		},
		agentDir,
		socket,
		{
			hostInstance: "successor",
			onProgress: (state) => {
				progress = state;
			},
		},
	);
	seen.push(progress);

	expect(seen[0]).toEqual({ pending: 2, predecessorDraining: true });
	expect(seen.at(-1)).toBeUndefined();
});

it("list_sessions carries the takeover in progress as handover, and drops it once the takeover is done", async () => {
	const router = new SessionCommandRouter(
		evictionRegistry(idleEntry(0)),
		new SessionEventWriter(() => {}),
		{ cwd: process.cwd() },
		undefined,
		{},
		{ idleEvictionMs: Number.POSITIVE_INFINITY },
	);
	try {
		router.setInheritedHandover({ pending: 3, predecessorDraining: true });
		const during = await router.handle({ id: "list-1", type: "list_sessions" });
		expect(during).toMatchObject({
			success: true,
			data: { sessions: [{ sessionId: "rpc-1" }], handover: { pending: 3, predecessor_draining: true } },
		});
		router.setInheritedHandover(undefined);
		const after = await router.handle({ id: "list-2", type: "list_sessions" });
		expect(after?.success === true && "data" in after ? after.data : undefined).not.toHaveProperty("handover");
	} finally {
		await router.dispose();
	}
});
