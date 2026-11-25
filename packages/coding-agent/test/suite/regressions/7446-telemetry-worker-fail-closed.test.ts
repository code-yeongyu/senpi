import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import type { TelemetryCallersVerdict } from "../../../src/core/telemetry-consent.ts";
import { parkedEntryFromProfile, parkedOpenCommand } from "../../../src/modes/rpc/host-handover-parked-open.ts";
import type { RpcCommand } from "../../../src/modes/rpc/rpc-types.ts";
import {
	exitForTelemetryContainment,
	TELEMETRY_CONTAINMENT_EXIT_CODE,
	TELEMETRY_END_CONFIRM_MS,
	TELEMETRY_REVOKE_ACK_MS,
} from "../../../src/modes/rpc/session-router-telemetry.ts";
import { retainHost } from "../rpc-retain-on-disconnect-support.ts";

// senpi#7446 H1, deny-safe for worker sessions: telemetry is collected and exported inside the worker, so the host's
// lever is ending it. A stricter verdict the worker does not acknowledge within TELEMETRY_REVOKE_ACK_MS ends it, the
// end counts only once its exit is observed, and an unconfirmed grant stays off.

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

type Host = Awaited<ReturnType<typeof retainHost>>;
const OFF: TelemetryCallersVerdict = { events: false, attribution: false };
const ON: TelemetryCallersVerdict = { events: true, attribution: true };

function endedBy(host: Host, sessionId: string): boolean {
	return host.records.some(
		(record) =>
			record.type === "session_error" &&
			record.sessionId === sessionId &&
			record.error === "telemetry_update_unconfirmed",
	);
}

async function openAs(host: Host, consent: "granted" | "declined", sessionPath?: string) {
	const opened = await host.open("desktop", {
		retain_on_disconnect: true,
		telemetry: { consent },
		...(sessionPath !== undefined ? { sessionPath } : {}),
	});
	const sessionId = String((opened?.data as { sessionId?: string } | undefined)?.sessionId);
	const durableSessionId = host.registry.peek(sessionId)?.worker?.snapshot?.state.sessionId;
	if (durableSessionId === undefined) throw new Error("worker session has no durable id");
	return { sessionId, durableSessionId };
}

function setConsent(sessionId: string, consent: "granted" | "declined"): RpcCommand {
	return { type: "set_telemetry_consent", sessionId, consent };
}

function sendWithoutWaiting(host: Host, connection: string, command: RpcCommand) {
	return host.send(connection, command);
}

it("ends a worker that refuses a revocation, and reports the end only once its exit is observed", async () => {
	// given
	await using host = await retainHost();
	const { sessionId } = await openAs(host, "granted");
	host.telemetryUpdates.mode = "refuse";

	// when
	const refused = await host.send("desktop", setConsent(sessionId, "declined"));

	// then
	expect(refused?.errorCode).toBe("telemetry_update_unconfirmed");
	expect(refused?.errorData).toMatchObject({ workerEnded: true });
	expect(endedBy(host, sessionId)).toBe(true);
	expect(host.registry.peek(sessionId)?.telemetry?.confirmed ?? OFF).toEqual(OFF);
});

it("ends a silent worker exactly at TELEMETRY_REVOKE_ACK_MS after a revocation, not before", async () => {
	// given
	await using host = await retainHost();
	const { sessionId } = await openAs(host, "granted");
	host.telemetryUpdates.mode = "silent";
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

	// when
	const answered = sendWithoutWaiting(host, "desktop", setConsent(sessionId, "declined"));
	await vi.advanceTimersByTimeAsync(TELEMETRY_REVOKE_ACK_MS - 1);
	const beforeDeadline = endedBy(host, sessionId);
	await vi.advanceTimersByTimeAsync(1);
	const atDeadline = endedBy(host, sessionId);
	vi.useRealTimers();
	const refused = await answered;

	// then
	expect([beforeDeadline, atDeadline]).toEqual([false, true]);
	expect(refused?.errorCode).toBe("telemetry_update_unconfirmed");
});

const BOUND = TELEMETRY_REVOKE_ACK_MS + TELEMETRY_END_CONFIRM_MS;

/** Drives one stricter verdict to a worker that never stops, and reports when the exit port ran. */
async function containmentRun(options: {
	mode: "refuse" | "silent";
	breakNotification?: (host: Host) => void;
	exitPort?: boolean;
}): Promise<{ beforeBound: number; atBound: number; host: Host; sessionId: string; exits: number[] }> {
	const containmentLost: string[] = [];
	const host = await retainHost(
		options.exitPort === false ? {} : { onTelemetryContainmentLost: (id) => containmentLost.push(id) },
	);
	const exits: number[] = [];
	if (options.exitPort === false)
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			exits.push(code ?? 0);
			containmentLost.push("process.exit");
		}) as never);
	const { sessionId } = await openAs(host, "granted");
	host.telemetryUpdates.mode = options.mode;
	options.breakNotification?.(host);
	vi.spyOn(Worker.prototype, "terminate").mockImplementation(() => new Promise<number>(() => {}));
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const answered = sendWithoutWaiting(host, "desktop", setConsent(sessionId, "declined"));
	await vi.advanceTimersByTimeAsync(BOUND - 1);
	const beforeBound = containmentLost.length;
	await vi.advanceTimersByTimeAsync(1);
	const atBound = containmentLost.length;
	vi.useRealTimers();
	await answered;
	return { beforeBound, atBound, host, sessionId, exits };
}

it("contains a refusing worker that never stops at the bound, not one tick earlier", async () => {
	const run = await containmentRun({ mode: "refuse" });
	await using _ = run.host;

	expect([run.beforeBound, run.atBound]).toEqual([0, 1]);
	expect(run.host.registry.peek(run.sessionId)?.telemetry?.confirmed).toEqual(ON);
});

it("contains a silent worker that never stops at 4000 ms end to end, after telling every client why", async () => {
	const run = await containmentRun({ mode: "silent" });
	await using _ = run.host;

	expect(BOUND).toBe(4_000);
	expect([run.beforeBound, run.atBound]).toEqual([0, 1]);
	expect(run.host.records.filter((record) => record.type === "host_telemetry_containment")).toEqual([
		{ type: "host_telemetry_containment", sessionId: run.sessionId, exitCode: TELEMETRY_CONTAINMENT_EXIT_CODE },
	]);
});

/** Breaks only the flush that follows the containment broadcast; every other flush (the fixture's own) still runs. */
function breakNoticeFlush(host: Host, broken: () => Promise<void>): void {
	let noticeSent = false;
	const broadcast = host.writer.broadcastHostRecord.bind(host.writer);
	vi.spyOn(host.writer, "broadcastHostRecord").mockImplementation((record) => {
		broadcast(record);
		if (record.type === "host_telemetry_containment") noticeSent = true;
	});
	const flush = host.writer.flush.bind(host.writer);
	vi.spyOn(host.writer, "flush").mockImplementation(() => {
		if (!noticeSent) return flush();
		noticeSent = false;
		return broken();
	});
}

it.each([
	["a flush that never resolves", (host: Host) => breakNoticeFlush(host, () => new Promise<void>(() => {}))],
	[
		"a flush that rejects",
		(host: Host) => breakNoticeFlush(host, () => Promise.reject(new Error("connection reset"))),
	],
	[
		"a broadcast that throws",
		(host: Host) =>
			vi.spyOn(host.writer, "broadcastHostRecord").mockImplementation(() => {
				throw new Error("writer closed");
			}),
	],
])("still contains at the bound when the notification fails: %s", async (_label, breakNotification) => {
	const run = await containmentRun({ mode: "silent", breakNotification });
	await using _ = run.host;

	expect([run.beforeBound, run.atBound]).toEqual([0, 1]);
});

it("runs the production exit at the bound: process.exit(79), even when stderr fails", async () => {
	vi.spyOn(process.stderr, "write").mockImplementation(() => {
		throw new Error("stderr closed");
	});
	const run = await containmentRun({ mode: "silent", exitPort: false });
	await using _ = run.host;

	expect([run.beforeBound, run.atBound, run.exits]).toEqual([0, 1, [TELEMETRY_CONTAINMENT_EXIT_CODE]]);
});

it("writes one stderr reason line and exits with TELEMETRY_CONTAINMENT_EXIT_CODE by default", () => {
	// given
	const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
	const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

	// when
	exitForTelemetryContainment("session-x");

	// then
	expect(exit).toHaveBeenCalledWith(TELEMETRY_CONTAINMENT_EXIT_CODE);
	expect(stderr.mock.calls.map(([line]) => String(line))).toEqual([
		`senpi rpc host exiting ${TELEMETRY_CONTAINMENT_EXIT_CODE}: worker for session session-x did not stop after a telemetry revocation\n`,
	]);
});

it("ends a worker that did not confirm an attaching caller's decline, and undoes the attach", async () => {
	// given
	await using host = await retainHost();
	const { sessionId, durableSessionId } = await openAs(host, "granted");
	host.telemetryUpdates.mode = "refuse";

	// when
	const attached = await host.send("observer", {
		type: "attach_session",
		sessionId,
		durableSessionId,
		telemetry: { consent: "declined" },
	});

	// then
	expect([attached?.success, attached?.errorCode]).toEqual([false, "telemetry_update_unconfirmed"]);
	expect(endedBy(host, sessionId)).toBe(true);
});

it("keeps a grant the worker did not confirm off, and applies it once confirmed", async () => {
	// given
	await using host = await retainHost();
	const { sessionId } = await openAs(host, "declined");
	host.telemetryUpdates.mode = "refuse";

	// when
	const refused = await host.send("desktop", setConsent(sessionId, "granted"));
	const keptAfterRefusal = host.registry.peek(sessionId)?.telemetry?.confirmed;
	host.telemetryUpdates.mode = "acknowledge";
	const applied = await host.send("desktop", setConsent(sessionId, "granted"));

	// then
	expect([refused?.errorCode, keptAfterRefusal, endedBy(host, sessionId)]).toEqual([
		"telemetry_update_unconfirmed",
		OFF,
		false,
	]);
	expect(applied?.success).toBe(true);
	expect(host.registry.peek(sessionId)?.telemetry?.confirmed).toEqual(ON);
});

it("reopens a session its unconfirmed revocation ended at the revoked answer, with nobody answering again", async () => {
	// given
	await using host = await retainHost();
	const sessionPath = `${host.cwd}/ended.jsonl`;
	const { sessionId } = await openAs(host, "granted", sessionPath);
	const entry = host.registry.peek(sessionId);
	host.telemetryUpdates.mode = "refuse";
	await host.send("desktop", setConsent(sessionId, "declined"));
	const profile = entry?.profile;
	host.telemetryUpdates.mode = "acknowledge";

	// when
	await host.send("successor", parkedOpenCommand(parkedEntryFromProfile({ sessionPath }, profile, [])));
	const prepared = host.posted.findLast(({ message }) => message.type === "prepare")?.message;

	// then
	expect(profile?.telemetryConsent).toBe("declined");
	expect(prepared?.type === "prepare" ? prepared.profile.telemetryConsent : undefined).toBe("declined");
});
