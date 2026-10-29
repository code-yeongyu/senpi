// code-yeongyu/oh-my-openagent#10091: a session may transfer long after its successor took the socket. The successor's
// reopen watch ended after 120 s or a quiet streak, deleted a park after eight failed opens, and removed whatever record
// the path had. It now consumes parks for as long as a predecessor runs or a park remains, and every wake here is driven.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostDaemonPaths } from "../../../src/modes/rpc/host-daemon-paths.ts";
import {
	readHandoverParkedSessions,
	recordHandoverParkedSession,
} from "../../../src/modes/rpc/host-handover-parked.ts";
import {
	type ReopenWake,
	type ReopenWatch,
	reopenHandoverParkedSessions,
} from "../../../src/modes/rpc/host-handover-reopen.ts";
import { RpcSessionRegistryError } from "../../../src/modes/rpc/session-registry.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function endpoint() {
	const agentDir = await mkdtemp(join(tmpdir(), "senpi-10091-reopen-"));
	roots.push(agentDir);
	const socket = join(agentDir, "host.sock");
	return { agentDir, socket, daemonDir: createHostDaemonPaths({ socket, agentDir }).dir };
}

async function park(where: { agentDir: string; daemonDir: string }, name: string, transferId: string): Promise<string> {
	const sessionPath = join(where.agentDir, `${name}.jsonl`);
	await writeFile(sessionPath, "", "utf8");
	await recordHandoverParkedSession(where.daemonDir, {
		sessionPath,
		retainOnDisconnect: true,
		parkedBy: "predecessor",
		transferId,
	});
	return sessionPath;
}

function drivenWatch(live: boolean) {
	const order: string[] = [];
	let wake: (cause: ReopenWake) => void = () => {};
	let idle = Promise.withResolvers<void>();
	const state = { live };
	const watch: ReopenWatch = {
		subscribe(listener) {
			order.push("subscribe");
			wake = listener;
			return () => order.push("unsubscribe");
		},
		predecessorLive: async () => state.live,
		idle: () => {
			const reached = idle;
			idle = Promise.withResolvers<void>();
			reached.resolve();
		},
	};
	return {
		watch,
		order,
		state,
		/** Taken BEFORE the action it waits on: resolves when the consumer next waits for a wake. */
		nextIdle: () => idle.promise,
		fire: (cause: ReopenWake) => wake(cause),
	};
}

const SUCCESSOR = { hostInstance: "successor" };

describe("a successor's reopen of its predecessor's parks", () => {
	it("still reopens a park that lands after the old 120-second watch, until no predecessor runs", async () => {
		vi.useFakeTimers();
		const where = await endpoint();
		const driven = drivenWatch(true);
		const opened: string[] = [];
		let returned = false;
		const firstIdle = driven.nextIdle();
		const consumer = reopenHandoverParkedSessions(
			async (entry) => {
				opened.push(entry.sessionPath);
			},
			where.agentDir,
			where.socket,
			SUCCESSOR,
			driven.watch,
		).then(() => {
			returned = true;
		});
		await firstIdle;

		await vi.advanceTimersByTimeAsync(10 * 60_000 + 121_000);
		expect(returned).toBe(false);
		const late = await park(where, "late", "t-late");
		const reopened = driven.nextIdle();
		driven.fire("record");
		await reopened;

		expect(opened).toEqual([late]);
		expect(await readHandoverParkedSessions(where.daemonDir)).toEqual([]);
		driven.state.live = false;
		driven.fire("generations");
		await consumer;
		expect(driven.order).toEqual(["subscribe", "unsubscribe"]);
	}, 15_000);

	it("subscribes before its first scan", async () => {
		const where = await endpoint();
		await park(where, "early", "t-early");
		const driven = drivenWatch(false);

		await reopenHandoverParkedSessions(
			async (entry) => {
				driven.order.push(`open ${entry.transferId}`);
			},
			where.agentDir,
			where.socket,
			SUCCESSOR,
			driven.watch,
		);

		expect(driven.order).toEqual(["subscribe", "open t-early", "unsubscribe"]);
	}, 15_000);

	it("removes only the record of the transfer it reopened", async () => {
		const where = await endpoint();
		const path = await park(where, "same", "t-1");
		const driven = drivenWatch(false);
		const reopened: Array<string | undefined> = [];

		await reopenHandoverParkedSessions(
			async (entry) => {
				reopened.push(entry.transferId);
				// The path is parked again, as another transfer, while this reopen is in flight.
				if (entry.transferId === "t-1")
					await recordHandoverParkedSession(where.daemonDir, {
						sessionPath: path,
						retainOnDisconnect: true,
						parkedBy: "predecessor",
						transferId: "t-2",
					});
			},
			where.agentDir,
			where.socket,
			SUCCESSOR,
			driven.watch,
		);

		expect(reopened).toEqual(["t-1", "t-2"]);
		expect(await readHandoverParkedSessions(where.daemonDir)).toEqual([]);
	}, 15_000);

	it("keeps a park whose reopen failed, records why, and tries again on a claim change, not on its own record", async () => {
		const where = await endpoint();
		const path = await park(where, "flaky", "t-1");
		const driven = drivenWatch(true);
		let failing = true;
		let attempts = 0;
		const firstIdle = driven.nextIdle();
		const consumer = reopenHandoverParkedSessions(
			async () => {
				attempts += 1;
				if (failing) throw new RpcSessionRegistryError("open_failed", "model unavailable");
			},
			where.agentDir,
			where.socket,
			SUCCESSOR,
			driven.watch,
		);
		// A consumer that gives up settles instead of waiting: either way the record is read only afterwards.
		await Promise.race([firstIdle, consumer]);
		expect(await readHandoverParkedSessions(where.daemonDir)).toMatchObject([
			{
				sessionPath: path,
				transferId: "t-1",
				failedTransfer: { attempts: 1, reason: expect.stringContaining("model") },
			},
		]);

		const afterOwnRecord = driven.nextIdle();
		driven.fire("record");
		await afterOwnRecord;
		expect(attempts).toBe(1);

		failing = false;
		const afterClaim = driven.nextIdle();
		driven.fire("claims");
		await afterClaim;
		expect(attempts).toBe(2);
		expect(await readHandoverParkedSessions(where.daemonDir)).toEqual([]);
		driven.state.live = false;
		driven.fire("generations");
		await consumer;
	}, 15_000);

	it("waits on a claim its predecessor still holds without recording a failure", async () => {
		const where = await endpoint();
		await park(where, "held", "t-1");
		const driven = drivenWatch(true);
		let held = true;
		const firstIdle = driven.nextIdle();
		const consumer = reopenHandoverParkedSessions(
			async () => {
				if (held) throw new RpcSessionRegistryError("session_path_in_use", "held by the predecessor");
			},
			where.agentDir,
			where.socket,
			SUCCESSOR,
			driven.watch,
		);
		await firstIdle;
		const [waiting] = await readHandoverParkedSessions(where.daemonDir);
		expect(waiting?.failedTransfer).toBeUndefined();

		held = false;
		const afterRelease = driven.nextIdle();
		driven.fire("claims");
		await afterRelease;
		expect(await readHandoverParkedSessions(where.daemonDir)).toEqual([]);
		driven.state.live = false;
		driven.fire("generations");
		await consumer;
	}, 15_000);
});
