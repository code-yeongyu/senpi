import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { readSessionRetirement, retireSession } from "../../../src/core/session-retirement.ts";
import { inProcessRuntimeFactory } from "../rpc-inprocess-host-support.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import {
	readHandoverParkedSessions,
	recordHandoverParkedSession,
} from "../../../src/modes/rpc/host-handover-parked.ts";
import { reopenHandoverParkedSessions } from "../../../src/modes/rpc/host-handover-reopen.ts";
import { currentResidentWriter } from "../../../src/modes/rpc/host-handover-resident-writer.ts";

it.each(["handover", "retained restart"] as const)("does not open a retired session during %s", async (source) => {
	const agentDir = await mkdtemp(join(tmpdir(), "retirement-"));
	try {
		const socket = join(agentDir, "host.sock");
		const daemonDir = createHostDaemonPaths({ agentDir, socket }).dir;
		const retired = "00000000-0000-4000-8000-000000000001";
		const active = "00000000-0000-4000-8000-000000000002";
		const timestamp = new Date(0).toISOString();
		const writer = await currentResidentWriter();
		for (const id of [retired, active]) {
			const sessionPath = join(agentDir, `${id}.jsonl`);
			await writeFile(
				sessionPath,
				`${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: agentDir })}\n`,
			);
			await recordHandoverParkedSession(daemonDir, {
				cwd: agentDir,
				sessionPath,
				durableSessionId: id,
				retainOnDisconnect: true,
				parkedBy: "previous",
				...(source === "retained restart" && { residentWriter: { ...writer, bootAtMs: 0 } }),
			});
		}
		const store = join(agentDir, "retired-sessions");
		await mkdir(store);
		await writeFile(
			join(store, `${retired}.json`),
			JSON.stringify({ version: 1, retiredAt: timestamp, reason: "requested" }),
		);

		const open = vi.fn(async (_entry: { durableSessionId?: string }) => {});
		let passes = 0;
		await reopenHandoverParkedSessions(open, agentDir, socket, {
			hostInstance: "successor",
			shouldReopen: () => passes++ < 3,
			onProgress: () => {},
		});
		expect(open.mock.calls.map(([entry]) => entry.durableSessionId)).toEqual([active]);
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});

// senpi#7622: a header id that is not a session id names no marker, so that park is skipped and kept, never the end of the restore.
it("skips a parked transcript whose header id is invalid and still restores the others", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "retirement-header-"));
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	try {
		const socket = join(agentDir, "host.sock");
		const daemonDir = createHostDaemonPaths({ agentDir, socket }).dir;
		const timestamp = new Date(0).toISOString();
		const malformed = join(agentDir, "malformed.jsonl");
		const active = join(agentDir, "active.jsonl");
		for (const [sessionPath, id] of [
			[malformed, "not a session id"],
			[active, "00000000-0000-4000-8000-000000000003"],
		] as const) {
			await writeFile(
				sessionPath,
				`${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: agentDir })}\n`,
			);
			await recordHandoverParkedSession(daemonDir, {
				cwd: agentDir,
				sessionPath,
				durableSessionId: id,
				retainOnDisconnect: true,
				parkedBy: "previous",
			});
		}

		const open = vi.fn(async (_entry: { sessionPath: string }) => {});
		let passes = 0;
		await reopenHandoverParkedSessions(open, agentDir, socket, {
			hostInstance: "successor",
			shouldReopen: () => passes++ < 3,
		});
		expect(open.mock.calls.map(([entry]) => entry.sessionPath)).toEqual([active]);
		expect((await readHandoverParkedSessions(daemonDir)).map((entry) => entry.sessionPath)).toEqual([malformed]);
		// Two passes saw the skipped park; the host log names it and the reason once.
		const records = stderr.mock.calls
			.map(([chunk]) => String(chunk))
			.filter((line) => line.includes(malformed) && line.includes("retirement_marker_unavailable"));
		expect(records).toHaveLength(1);
	} finally {
		stderr.mockRestore();
		await rm(agentDir, { recursive: true, force: true });
	}
});

it("keeps retirement through ordinary and failed opens; only an explicit successful reopen consumes it", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "retirement-open-"));
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: inProcessRuntimeFactory().createRuntime,
	});
	const router = new SessionCommandRouter(
		registry,
		new SessionEventWriter(() => {}),
		{ cwd: agentDir, agentDir },
		async () => ({ handle: async () => {}, dispose: async () => {} }),
	);
	const id = "retirement-control";
	const dir = join(agentDir, "sessions");
	const sessionPath = join(dir, `fixture_${id}.jsonl`);
	const request = { type: "open_session", sessionPath, cwd: agentDir } as const;
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(
			sessionPath,
			`${JSON.stringify({ type: "session", version: 3, id, cwd: agentDir, timestamp: new Date(0).toISOString() })}\n`,
		);
		const marker = await retireSession({ agentDir, sessionPath, reason: "takeover" });
		expect(await retireSession({ agentDir, sessionPath, reason: "takeover" })).toEqual(marker);
		expect(await router.handle({ type: "find_session", durableSessionId: id })).toMatchObject({
			data: { found: { open: false, retirement: marker } },
		});
		expect(await router.handle(request)).toMatchObject({ errorCode: "session_retired", errorData: marker });
		// senpi#7622: an open by reference (the durable id alone, no path) is refused like an open by path.
		expect(await router.handle({ type: "open_session", cwd: agentDir, durableSessionId: id })).toMatchObject({
			errorCode: "session_retired",
			errorData: marker,
		});
		expect(await router.handle({ ...request, reopenRetired: true, cwd: sessionPath })).toMatchObject({
			success: false,
		});
		expect(await readSessionRetirement(agentDir, id)).toEqual(marker);
		expect(await router.handle({ ...request, reopenRetired: true })).toBeUndefined();
		expect(await readSessionRetirement(agentDir, id)).toBeUndefined();
		const [row] = registry.list();
		if (!row) throw new Error("explicit reopen did not create a resident session");
		expect(
			await router.handle({ type: "release_session", sessionId: row.sessionId, reason: "takeover", force: true }),
		).toMatchObject({ success: true });
		expect(await router.handle(request)).toBeUndefined();
		const [successor] = registry.list();
		if (!successor) throw new Error("same-session handback did not reopen");
		expect(successor.durableSessionId).toBe(id);
		expect(await router.handle({ type: "close_session", sessionId: successor.sessionId })).toBeUndefined();
		expect(await readSessionRetirement(agentDir, id)).toBeUndefined();
		expect(await router.handle(request)).toBeUndefined();
		const [reopened] = registry.list();
		if (!reopened) throw new Error("a plainly closed session did not reopen from its file");
		// Marking a live session does not stop it; its resident row is where a controller sees the mark.
		const liveMark = await retireSession({ agentDir, sessionPath, reason: "takeover" });
		expect(await router.handle({ type: "list_sessions" })).toMatchObject({
			data: { sessions: [{ sessionId: reopened.sessionId, retirement: liveMark }] },
		});
		expect(
			await router.handle({ type: "close_session", sessionId: reopened.sessionId, retire: true }),
		).toBeUndefined();
		expect(await readSessionRetirement(agentDir, id)).toEqual(liveMark);
		expect(await router.handle(request)).toMatchObject({ errorCode: "session_retired", errorData: liveMark });
		expect(await router.handle({ type: "close_session", sessionId: "no-such-session", retire: true })).toMatchObject({
			success: false,
			error: "unknown_session",
		});
		const store = join(agentDir, "retired-sessions");
		await rm(store, { recursive: true });
		await writeFile(store, "not a directory");
		expect(await router.handle({ ...request, reopenRetired: true })).toMatchObject({
			errorCode: "retirement_store_unavailable",
			errorData: { store: "retired-sessions" },
		});
		const socket = join(agentDir, "restore.sock");
		await recordHandoverParkedSession(createHostDaemonPaths({ agentDir, socket }).dir, {
			cwd: agentDir,
			durableSessionId: id,
			sessionPath,
			retainOnDisconnect: true,
		});
		const open = vi.fn(async () => {});
		await reopenHandoverParkedSessions(open, agentDir, socket, { hostInstance: "successor" });
		expect(open).not.toHaveBeenCalled();
	} finally {
		await router.dispose();
		await rm(agentDir, { recursive: true, force: true });
	}
});

it("distinguishes absent, damaged marker and inaccessible store without marking other identities", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "retirement-fault-"));
	const store = join(agentDir, "retired-sessions");
	try {
		expect(await readSessionRetirement(agentDir, "one")).toBeUndefined();
		await mkdir(store);
		await writeFile(join(store, "one.json"), "{");
		await expect(readSessionRetirement(agentDir, "one")).rejects.toMatchObject({
			code: "retirement_marker_unavailable",
			detail: { marker: "retired-sessions/one.json" },
			path: join(store, "one.json"),
		});
		expect(await readSessionRetirement(agentDir, "two")).toBeUndefined();
		await rm(store, { recursive: true });
		await writeFile(store, "not a directory");
		await expect(readSessionRetirement(agentDir, "two")).rejects.toMatchObject({
			code: "retirement_store_unavailable",
			detail: { store: "retired-sessions" },
			path: store,
		});
		expect(await retireSession({ agentDir, reason: "requested" })).toEqual({ reason: "memory_only" });
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
});
