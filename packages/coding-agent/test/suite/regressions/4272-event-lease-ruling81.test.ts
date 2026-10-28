import { afterEach, expect, it, vi } from "vitest";
import { TransferStaging, TransferStagingError } from "../../../src/modes/rpc/compact-transfer-staging.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { FLAG } from "./4272-construction-host-support.ts";

// Part of #4272 (S13, RULING-81): the contract owner's conditions on the event-lease route. Q-A: release_recovery
// covers event leases only and refuses a checkpoint token, typed. Q-B: `compact_events` is accepted only behind the
// flag; a peer that did not offer it gets the legacy encoding. Q-C: `lease.kind` discriminates both kinds and an
// unknown kind is a typed refusal, never a default. (3): the exact behaviour mirror-only audiences and lane-less
// sessions get today (no lease: the complete record). Measurements: descriptors per record type, retained failure bytes.

const F = 262_144;
const COMPACT_EVENTS = "compact_events";
const wireBytes = (record: WireRecord): number => Buffer.byteLength(`${JSON.stringify(record)}\n`);
const leaseOf = (record: WireRecord) => record.eventLease as { id: string; admissionId: string } | undefined;
const oversized = (callId: string, type = "tool_execution_end") => ({
	type,
	toolCallId: callId,
	result: { content: [{ type: "text", text: "r".repeat(300_000) }] },
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

async function compactHost() {
	vi.stubEnv(FLAG, "1");
	const host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const opener = host.client("opener");
	const routing = String(dataOf(await opener.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	admissions.mockRestore();
	const lane = entry?.acceptance ?? expect.unreachable("no acceptance lane with the flag on");
	const pi = [...host.extensionApis.values()].at(-1) ?? expect.unreachable("no session extension API");
	const compact = host.client("compact");
	host.writer.setConnectionCapabilities("compact", [COMPACT_EVENTS]);
	host.writer.attachConnectionToSession("compact", routing);
	return { host, opener, compact, routing, lane, pi };
}

function checkpointFor(setup: Awaited<ReturnType<typeof compactHost>>) {
	const socketEpoch = setup.host.writer.socketEpochOf("compact") ?? expect.unreachable();
	const route = {
		socketEpoch,
		admissionId: "attach-r81",
		routeKind: "ordinary" as const,
		peer: "compact",
		sessionId: setup.routing,
	};
	const frozen = setup.host.writer.recoveryCheckpoints.freeze(route, setup.lane);
	if (!frozen.ok) throw new Error(`freeze refused: ${JSON.stringify(frozen.failure)}`);
	return frozen.value.token;
}

it("RULING-81 Q-A release_recovery refuses a checkpoint token, typed, and the token stays live", async () => {
	const setup = await compactHost();
	const { host, compact, routing } = setup;
	try {
		const token = checkpointFor(setup);
		const caller = { socketEpoch: token.admission.socketEpoch, sessionId: routing };
		const asEvent = await compact.request({
			type: "release_recovery",
			sessionId: routing,
			lease: { kind: "event", id: token.id },
			admissionId: token.admission.admissionId,
		});
		expect(asEvent).toMatchObject({
			success: false,
			error: "recovery_repair_needed",
			errorData: { reason: "unknown_token" },
		});
		const asCheckpoint = await compact.request({
			type: "release_recovery",
			sessionId: routing,
			lease: { kind: "checkpoint", id: token.id },
			admissionId: token.admission.admissionId,
		});
		expect(asCheckpoint).toMatchObject({
			success: false,
			error: "recovery_lease_kind_unsupported",
			errorData: { kind: "request_refused", reason: "lease_kind_unsupported" },
		});
		expect(host.writer.recoveryCheckpoints.check(token, caller).ok, "a refused receipt releases nothing").toBe(true);
		host.writer.recoveryCheckpoints.release(token);
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 300_000);

it("RULING-81 Q-B compact_events is refused with the flag off and, with the flag on, a peer that did not offer it gets the legacy encoding", async () => {
	const off = new SessionEventWriter(() => {});
	off.registerConnection("peer", { writeRaw: () => {}, waitForBackpressure: async () => {} });
	off.setConnectionCapabilities("peer", [COMPACT_EVENTS, "media_placeholders"]);
	expect(off.getConnectionCapabilities("peer"), "the flag is off: the opt-in is not accepted").toEqual([
		"media_placeholders",
	]);
	off.unregisterConnection("peer");
	const { host, opener, compact, routing } = await compactHost();
	try {
		expect(host.writer.getConnectionCapabilities("compact")).toEqual([COMPACT_EVENTS]);
		host.writer.enqueue(routing, oversized("c-b"));
		await host.writer.flush();
		const legacy = opener.inbox.find((record) => record.toolCallId === "c-b") ?? expect.unreachable();
		expect(wireBytes(legacy)).toBeGreaterThan(F);
		expect(legacy).toEqual({ ...oversized("c-b"), sessionId: routing });
		expect(compact.inbox.filter((record) => leaseOf(record) !== undefined)).toHaveLength(1);
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 300_000);

it("RULING-81 Q-C lease.kind routes both kinds and an unknown kind is a typed refusal, never a default", async () => {
	const setup = await compactHost();
	const { host, compact, routing } = setup;
	try {
		const token = checkpointFor(setup);
		const caller = { socketEpoch: token.admission.socketEpoch, sessionId: routing };
		const manifest = await host.writer.recoveryCheckpoints.catalog(token, caller);
		if (!manifest.ok) throw new Error("no manifest");
		const root = await host.writer.recoveryCheckpoints.readCatalog(token, caller, manifest.value.catalogRoot);
		if (!root.ok || root.value.kind !== "node") throw new Error("the catalog root is a node");
		const index = root.value.entries.findIndex((entry) => entry.kind !== "node");
		const componentRef = `${manifest.value.catalogRoot}:${String(index).padStart(3, "0")}`;
		const page = (lease: Record<string, unknown>, componentRef: string, admissionId: string, requestId: string) =>
			compact.request({
				type: "get_recovery_page",
				sessionId: routing,
				lease,
				admissionId,
				componentRef,
				requestId,
			});
		const checkpoint = await page(
			{ kind: "checkpoint", id: token.id },
			componentRef,
			token.admission.admissionId,
			"k-1",
		);
		expect({ ...checkpoint, error: checkpoint.error }).toMatchObject({
			success: true,
			data: { token: token.id, generation: token.admission.generation, ordinal: 1 },
		});
		host.writer.enqueue(routing, oversized("c-c"));
		await host.writer.flush();
		const lease = compact.inbox.map(leaseOf).find((each) => each !== undefined) ?? expect.unreachable();
		const event = await page({ kind: "event", id: lease.id }, "record", lease.admissionId, "k-2");
		expect(event).toMatchObject({ success: true, data: { lease: { kind: "event", id: lease.id }, ordinal: 1 } });
		for (const kind of ["bogus", undefined, 7]) {
			const refused = await page({ kind, id: lease.id }, "record", lease.admissionId, `k-${String(kind)}`);
			expect(refused).toMatchObject({ success: false, error: "recovery_malformed_request" });
			const release = await compact.request({
				type: "release_recovery",
				sessionId: routing,
				lease: { kind, id: lease.id },
				admissionId: lease.admissionId,
			});
			expect(release).toMatchObject({ success: false, error: "recovery_malformed_request" });
		}
		expect(host.writer.recoveryEvents?.status().open, "no refusal touched the lease").toBe(1);
		host.writer.recoveryCheckpoints.release(token);
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 300_000);

it("RULING-81 (3) a mirror-only audience and a lane-less session get no lease: the complete record, as today's legacy peers", async () => {
	const { host, routing } = await compactHost();
	try {
		const mirror = host.client("mirror");
		dataOf(
			await mirror.request({ type: "subscribe_sessions", sessions: "all", include_workers: true, mirror: "all" }),
		);
		host.writer.setConnectionCapabilities("mirror", [COMPACT_EVENTS]);
		host.writer.enqueue(routing, oversized("c-mirror"));
		await host.writer.flush();
		const mirrored = mirror.inbox.find((record) => record.toolCallId === "c-mirror");
		expect(mirrored, "mirror-only: the complete record, no lease").toEqual({
			...oversized("c-mirror"),
			sessionId: routing,
		});
	} finally {
		await host[Symbol.asyncDispose]();
	}
	const laneless = new SessionEventWriter(() => {});
	const seen: string[] = [];
	laneless.registerConnection("peer", {
		writeRaw: (line) => void seen.push(line),
		waitForBackpressure: async () => {},
	});
	laneless.setConnectionCapabilities("peer", [COMPACT_EVENTS]);
	laneless.attachConnectionToSession("peer", "rpc-no-lane");
	laneless.enqueue("rpc-no-lane", oversized("c-laneless"));
	await laneless.flush();
	const records = seen
		.join("")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as WireRecord);
	expect(
		records.find((record) => record.toolCallId === "c-laneless"),
		"lane-less: the complete record, no lease",
	).toEqual({
		...oversized("c-laneless"),
		sessionId: "rpc-no-lane",
	});
	expect(laneless.recoveryEvents?.status()).toMatchObject({ minted: 0, open: 0 });
	laneless.unregisterConnection("peer");
}, 300_000);

it("RULING-81 measurements: descriptors per record type on the real path, and the bytes a staging failure retains", async () => {
	const { host, compact, routing, pi } = await compactHost();
	try {
		const events = host.writer.recoveryEvents ?? expect.unreachable();
		const ended = compact.waitFor((record) => record.type === "message_end" && leaseOf(record) !== undefined);
		await pi.sendMessage({ customType: "r81", content: `large ${"m".repeat(300_000)}`, display: true });
		await ended;
		for (const type of ["tool_execution_start", "tool_execution_end", "tool_execution_update"])
			host.writer.enqueue(routing, oversized(`c-${type}`, type));
		await host.writer.flush();
		const perType: Record<string, number> = {};
		for (const record of compact.inbox)
			if (leaseOf(record) !== undefined) perType[String(record.type)] = (perType[String(record.type)] ?? 0) + 1;
		const pinned = events.status().contentBytes;
		process.stdout.write(`S13-MEASURE descriptors-per-type ${JSON.stringify(perType)} pinned-bytes ${pinned}\n`);
		expect(Object.values(perType).reduce((sum, count) => sum + count, 0)).toBe(events.status().minted);
		const before = events.status();
		vi.spyOn(TransferStaging.prototype, "stage").mockImplementation(() => {
			throw new TransferStagingError("staging_over_byte_limit");
		});
		host.writer.enqueue(routing, oversized("c-fail"));
		await host.writer.flush();
		const after = events.status();
		const retained = after.contentBytes - before.contentBytes;
		process.stdout.write(`S13-MEASURE failure retained-bytes ${retained} refused ${JSON.stringify(after.refused)}\n`);
		expect(retained, "a refused record retains no staged bytes").toBe(0);
		expect(after.refused).toMatchObject({ storage_unavailable: 1 });
		expect(compact.inbox.at(-1)).toEqual({
			type: "event_lease_refused",
			sessionId: routing,
			reason: "storage_unavailable",
		});
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 300_000);
