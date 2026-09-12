// Regression for senpi issue #1612: shared-host session-write grants were held for the
// worker's entire lifetime, so a long-lived session died at the 64-path reservation cap
// with session_path_in_use, and a superseded path stayed unopenable forever.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
	liveSessionWritePaths,
	registerSessionWriter,
	type SessionWriterOwner,
	unregisterSessionWriter,
} from "../../../src/core/session-write-reservation.ts";
import { RESERVATION_DENIAL_CODES, SessionPathReservations } from "../../../src/modes/rpc/session-path-reservations.ts";
import { SESSION_WORKER_LIMITS, type SessionWriteGrant } from "../../../src/modes/rpc/session-worker-protocol.ts";
import { reservationPhase as phase, reservationHost } from "../rpc-worker-reservation-support.ts";

const responseSchema = z.object({ id: z.string(), success: z.boolean(), error: z.string().optional() });

/** Ids of the published responses that reported success, in publication order. */
function acceptedResponseIds(records: readonly unknown[]): string[] {
	return records.flatMap((record) => {
		const parsed = responseSchema.safeParse(record);
		return parsed.success && parsed.data.success ? [parsed.data.id] : [];
	});
}

/** The wire code a grant is reported with; a granted path reports nothing. */
function denialCode(grant: SessionWriteGrant): string | undefined {
	return grant === "granted" ? undefined : RESERVATION_DENIAL_CODES[grant];
}

/** `<id>: <error>` for every published failure, so a rejection names its own cause. */
function rejectedResponses(records: readonly unknown[]): string[] {
	return records.flatMap((record) => {
		const parsed = responseSchema.safeParse(record);
		return parsed.success && !parsed.data.success ? [`${parsed.data.id}: ${parsed.data.error}`] : [];
	});
}

const header = (id: string, cwd: string): string =>
	`${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(0).toISOString(), cwd })}\n`;

/** The router answers a routed command only when it fails; success is published to the writer. */
function expectAccepted(response: unknown, label: string): void {
	expect(response, `${label} was rejected`).toBeUndefined();
}

async function scratchHost(name: string) {
	const scratch = await realpath(await mkdtemp(join(tmpdir(), `senpi-1612-${name}-`)));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	vi.stubEnv("SENPI_OFFLINE", "1");
	return { scratch, cwd, agentDir, host: reservationHost(cwd, agentDir) };
}

it("keeps granting session files when one session is replaced past the reservation cap", async () => {
	// Given: a single worker session opened on an existing session file.
	const { scratch, cwd, host } = await scratchHost("cap");
	const sessionPath = join(scratch, "long-lived.jsonl");
	await writeFile(sessionPath, header("long-lived-durable", cwd));
	host.connect("long-lived");
	try {
		expectAccepted(
			await phase("open", host.send("long-lived", { id: "open", type: "open_session", cwd, sessionPath })),
			"open_session",
		);
		const [opened] = host.registry.list();
		if (!opened) throw new Error("open_session did not register a session");

		// When: the client replaces that session more often than the per-worker cap.
		const rounds = Array.from({ length: 70 }, (_value, index) => `new-${index}`);
		for (const round of rounds) {
			const response = await phase(
				round,
				host.send("long-lived", { id: round, type: "new_session", sessionId: opened.sessionId }),
			);
			// Then: every replacement is granted its new session file.
			expectAccepted(response, `new_session ${round}`);
		}
		await host.writer.flush();
		expect(rejectedResponses(host.records)).toEqual([]);
		const accepted = new Set(acceptedResponseIds(host.records));
		expect(rounds.filter((round) => !accepted.has(round))).toEqual([]);

		// Then: superseded grants were released instead of accumulating.
		expect(host.registry.reservationCount(opened.sessionId)).toBeLessThanOrEqual(3);
	} finally {
		await host.dispose();
		vi.unstubAllEnvs();
		await rm(scratch, { recursive: true, force: true });
	}
}, 180_000);

it("releases a superseded session file to a new worker", async () => {
	// Given: a session opened on an existing file that is then replaced by /new.
	const { scratch, cwd, host } = await scratchHost("supersede");
	const sessionPath = join(scratch, "superseded.jsonl");
	await writeFile(sessionPath, header("superseded-durable", cwd));
	host.connect("first");
	host.connect("second");
	try {
		expectAccepted(
			await phase("open", host.send("first", { id: "open", type: "open_session", cwd, sessionPath })),
			"open_session",
		);
		const [opened] = host.registry.list();
		if (!opened) throw new Error("open_session did not register a session");
		expectAccepted(
			await phase(
				"supersede",
				host.send("first", { id: "supersede", type: "new_session", sessionId: opened.sessionId }),
			),
			"new_session",
		);

		// When: another connection opens the file the first worker no longer writes.
		const reopened = await phase(
			"reopen",
			host.send("second", { id: "reopen", type: "open_session", cwd, sessionPath }),
		);

		// Then: it gets its own worker instead of session_path_in_use or an attach.
		expectAccepted(reopened, "second open_session");
		const resumed = host.registry.list().find((entry) => entry.durableSessionId === "superseded-durable");
		expect(resumed?.sessionId).toBeDefined();
		expect(resumed?.sessionId).not.toBe(opened.sessionId);
		expect(host.registry.size).toBe(2);
		expect(host.workers.size).toBe(2);
	} finally {
		await host.dispose();
		vi.unstubAllEnvs();
		await rm(scratch, { recursive: true, force: true });
	}
}, 120_000);

it("separates an exhausted reservation budget from a path another worker owns", () => {
	// Given: one handle holding the whole per-worker budget, every path still live.
	const reservations = new SessionPathReservations();
	const live: string[] = [];
	for (let index = 0; index < SESSION_WORKER_LIMITS.reservations; index++) {
		const path = `/live/session-${index}.jsonl`;
		live.push(path);
		expect(reservations.reserve("rpc-1", path, { livePaths: live, sessionPath: path })).toBe("granted");
	}

	// When: that handle asks for one more path and another handle asks for a held one.
	const exhausted = reservations.reserve("rpc-1", "/live/overflow.jsonl", { livePaths: live });
	const taken = reservations.reserve("rpc-2", "/live/session-0.jsonl", { livePaths: [] });

	// Then: the budget denial and the ownership denial map to distinct wire codes.
	expect(exhausted).toBe("limit");
	expect(taken).toBe("conflict");
	expect(denialCode(exhausted)).toBe("session_reservation_limit");
	expect(denialCode(taken)).toBe("session_path_in_use");
	expect(reservations.count("rpc-1")).toBe(SESSION_WORKER_LIMITS.reservations);

	// And: once the worker reports only one live writer, the budget frees itself.
	const current = "/live/session-0.jsonl";
	expect(
		reservations.reserve("rpc-1", "/live/after-supersede.jsonl", { livePaths: [current], sessionPath: current }),
	).toBe("granted");
	expect(reservations.count("rpc-1")).toBe(2);
});

it("reports live persisted writers at their current session file", () => {
	// Given: two registered writers under a prefix owned by this test.
	const prefix = "/live-writers-1612/";
	let movable = `${prefix}first.jsonl`;
	const first: SessionWriterOwner = { getSessionFile: () => movable, isPersisted: () => true };
	const second: SessionWriterOwner = { getSessionFile: () => `${prefix}second.jsonl`, isPersisted: () => true };
	const owned = () => liveSessionWritePaths().filter((path) => path.startsWith(prefix));
	registerSessionWriter(first);
	registerSessionWriter(second);
	expect(owned().sort()).toEqual([`${prefix}first.jsonl`, `${prefix}second.jsonl`]);

	// When: one writer is unregistered and the other moves to a new file.
	unregisterSessionWriter(second);
	movable = `${prefix}first-replaced.jsonl`;

	// Then: only the remaining writer is reported, at its current path.
	expect(owned()).toEqual([`${prefix}first-replaced.jsonl`]);
	unregisterSessionWriter(first);
	expect(owned()).toEqual([]);
});
