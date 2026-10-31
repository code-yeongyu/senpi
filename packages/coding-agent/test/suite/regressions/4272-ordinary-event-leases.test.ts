import { afterEach, expect, expectTypeOf, it, vi } from "vitest";
import { type CatalogEntry, CatalogNodeWriter } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import { protocolId } from "../../../src/modes/rpc/compact-recovery-ids.ts";
import type {
	CheckpointToken,
	EventLease,
	RecoveryLease,
	RecoveryToken,
} from "../../../src/modes/rpc/compact-recovery-types.ts";
import { type FrozenRef, TransferStaging } from "../../../src/modes/rpc/compact-transfer-staging.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { RpcSessionRegistry, type RpcSessionEntry } from "../../../src/modes/rpc/session-registry.ts";
import { dataOf, type RawClient, statusHost, type WireRecord } from "../rpc-session-status-support.ts";
import { spoolRoot } from "../compact-storage-support.ts";
import { FLAG } from "./4272-construction-host-support.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";

// Part of #4272 (S13, R4.B6, RULING-65 S13-Q1/Q2 = A, RULING-63 acceptance): an ordinary event whose record is larger
// than F reaches a peer that selected compact events as a bounded envelope naming an event lease at the event's accepted
// sequence; the lease's pages reconstruct the exact record, a receipt releases it only when the consumer says it
// committed, and no new recovery generation is minted. A legacy peer keeps the complete record.

/** F (R4.A3): the largest compact physical record, newline included. */
const F = 262_144;
const COMPACT_EVENTS = "compact_events";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

interface LeaseRef {
	readonly kind: "event";
	readonly id: string;
	readonly admissionId: string;
	readonly sessionEpoch: string;
	readonly sequence: number;
	readonly componentRef: string;
	readonly length: number;
	readonly digest: string;
}

const leaseOf = (record: WireRecord): LeaseRef | undefined => record.eventLease as LeaseRef | undefined;
const wireBytes = (record: WireRecord): number => Buffer.byteLength(`${JSON.stringify(record)}\n`);
/** A tool result whose one text block alone is past F. */
const oversized = (callId: string, text: string) => ({
	type: "tool_execution_end",
	toolCallId: callId,
	toolName: "read",
	result: { content: [{ type: "text", text }], details: { note: "native block state" } },
	isError: false,
});

async function compactHost() {
	vi.stubEnv(FLAG, "1");
	const host = await statusHost();
	const admissions = vi.spyOn(RpcSessionRegistry.prototype, "getForCommand");
	const plain = host.client("plain");
	const routing = String(dataOf(await plain.request({ type: "open_session", cwd: host.cwd })).sessionId);
	const entry = admissions.mock.results.findLast((result) => result.type === "return")?.value as
		| RpcSessionEntry
		| undefined;
	admissions.mockRestore();
	const lane = entry?.acceptance ?? expect.unreachable("no real acceptance lane with the flag on");
	const pi = [...host.extensionApis.values()].at(-1) ?? expect.unreachable("no session extension API");
	const compact = host.client("compact");
	host.writer.setConnectionCapabilities("compact", [COMPACT_EVENTS]);
	host.writer.attachConnectionToSession("compact", routing);
	return { host, plain, compact, routing, lane, pi };
}

let requests = 0;
async function page(client: RawClient, routing: string, lease: LeaseRef, cursor?: string): Promise<WireRecord> {
	return client.request({
		type: "get_recovery_page",
		sessionId: routing,
		lease: { kind: "event", id: lease.id },
		admissionId: lease.admissionId,
		componentRef: lease.componentRef,
		requestId: `r-${++requests}`,
		...(cursor === undefined ? {} : { cursor }),
	});
}

/** Every page of the lease, each verified by its digest, and the whole against the envelope's length and digest. */
async function fetchLease(client: RawClient, routing: string, lease: LeaseRef): Promise<string> {
	const raw: Buffer[] = [];
	let cursor: string | undefined;
	for (;;) {
		const data = dataOf(await page(client, routing, lease, cursor)) as {
			bytes: string;
			length: number;
			digest: string;
			cursor: string | null;
			complete: boolean;
			lease: unknown;
		};
		expect(data.lease).toEqual({ kind: "event", id: lease.id });
		const bytes = Buffer.from(data.bytes, "base64");
		expect(bytes.length).toBe(data.length);
		expect(specDigest("fragment", bytes)).toBe(data.digest);
		raw.push(bytes);
		if (data.complete) break;
		cursor = data.cursor ?? expect.unreachable("an incomplete page names its cursor");
	}
	const all = Buffer.concat(raw);
	expect(all.length).toBe(lease.length);
	expect(specDigest("leaf", all)).toBe(lease.digest);
	return all.toString("utf16le");
}

function release(client: RawClient, routing: string, lease: LeaseRef): Promise<WireRecord> {
	return client.request({
		type: "release_recovery",
		sessionId: routing,
		lease: { kind: "event", id: lease.id },
		admissionId: lease.admissionId,
	});
}

// Part of the real path: the session's own `sendMessage` reaches the lane (which sequences it) before the writer.
it("T6 X04 S13-Q1 an oversized message_end reaches a compact-events peer as an envelope <= F whose lease pages rebuild the exact record at its accepted sequence, with no new generation; the legacy peer keeps the whole record", async () => {
	const { host, plain, compact, routing, lane, pi } = await compactHost();
	try {
		const caller = { socketEpoch: host.writer.socketEpochOf("compact") ?? "", sessionId: routing };
		const generation = host.writer.recoveryCheckpoints.stream(caller)?.generation;
		const accepted: { type: unknown; sequence: number | undefined }[] = [];
		const accept = SessionAcceptanceLane.prototype.accept;
		vi.spyOn(SessionAcceptanceLane.prototype, "accept").mockImplementation(function (
			this: SessionAcceptanceLane,
			record,
			...rest
		) {
			const ref = accept.call(this, record, ...rest);
			accepted.push({ type: Reflect.get(record, "type"), sequence: ref?.sequence });
			return ref;
		});
		const isEnd = (record: WireRecord) => record.type === "message_end";
		const delivered = plain.waitFor(isEnd);
		await pi.sendMessage({ customType: "s13", content: `large ${"z".repeat(300_000)}`, display: true });
		await delivered;
		await host.writer.flush();
		const legacyEnd = plain.inbox.find(isEnd) ?? expect.unreachable();
		expect(wireBytes(legacyEnd), "the legacy peer receives the complete oversized record").toBeGreaterThan(F);
		expect(plain.inbox.some((record) => leaseOf(record) !== undefined)).toBe(false);
		const largest = Math.max(...compact.inbox.map(wireBytes));
		expect(largest, "every record the compact peer received fits F").toBeLessThanOrEqual(F);
		const envelope = compact.inbox.find((record) => isEnd(record) && leaseOf(record) !== undefined);
		const lease = (envelope && leaseOf(envelope)) ?? expect.unreachable("no message_end lease envelope");
		expect(envelope).toEqual({ type: "message_end", sessionId: routing, eventLease: lease });
		expect(lease).toMatchObject({ kind: "event", componentRef: "record", sessionEpoch: lane.sessionEpoch });
		expect(lease.sequence, "the lease names the sequence the lane accepted the event at").toBe(
			accepted.find((each) => each.type === "message_end")?.sequence,
		);
		expect(JSON.parse(await fetchLease(compact, routing, lease))).toEqual(legacyEnd);
		expect(host.writer.recoveryCheckpoints.stream(caller)?.generation, "an event lease mints no generation").toBe(
			generation,
		);
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 120_000);

it("T6 T5 X04 a lease's bytes are fixed at acceptance: mutating the provider object and accepting a replacement never changes them", async () => {
	const { host, compact, routing } = await compactHost();
	try {
		const event = oversized("call-1", "a".repeat(300_000));
		host.writer.enqueue(routing, event);
		event.result.content[0] = { type: "text", text: "b".repeat(300_000) };
		host.writer.enqueue(routing, event);
		await host.writer.flush();
		const leases = compact.inbox.map(leaseOf).filter((lease) => lease !== undefined);
		expect(leases).toHaveLength(2);
		const [first, second] = leases;
		expect(first?.digest).not.toBe(second?.digest);
		const text = await fetchLease(compact, routing, first ?? expect.unreachable());
		expect(JSON.parse(text)).toMatchObject({ result: { content: [{ text: "a".repeat(300_000) }] } });
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 120_000);

it("S13-Q2 RULING-65 a lease is released only by its receipt: drain and a fully staged consumer that crashed before commit keep it, the receipt releases it once, a duplicate is a typed no-op and a foreign peer learns nothing", async () => {
	const { host, plain, compact, routing } = await compactHost();
	try {
		host.writer.enqueue(routing, oversized("call-2", "c".repeat(300_000)));
		await host.writer.flush();
		const events = host.writer.recoveryEvents ?? expect.unreachable("no event lease owner with the flag on");
		const lease = compact.inbox.map(leaseOf).find((each) => each !== undefined) ?? expect.unreachable();
		expect(events.status(), "transport drain is not a release point").toMatchObject({ open: 1, minted: 1 });
		const staged = await fetchLease(compact, routing, lease);
		// The consumer staged every page, then crashed before its commit: no receipt was sent.
		expect(events.status(), "staging is not ownership").toMatchObject({ open: 1, released: 0 });
		expect(await fetchLease(compact, routing, lease), "the content is recoverable byte for byte").toBe(staged);
		const foreign = await page(plain, routing, lease);
		expect(foreign).toMatchObject({ success: false, errorData: { kind: "repair_needed", reason: "unknown_token" } });
		expect(await release(plain, routing, lease)).toMatchObject({
			success: false,
			errorData: { kind: "repair_needed", reason: "unknown_token" },
		});
		expect(events.status().open, "a foreign receipt releases nothing").toBe(1);
		const receipt = dataOf(await release(compact, routing, lease));
		expect(receipt).toEqual({ lease: { kind: "event", id: lease.id }, outcome: "released", remaining: 0 });
		expect(dataOf(await release(compact, routing, lease)), "a retried receipt never decrements twice").toEqual({
			lease: { kind: "event", id: lease.id },
			outcome: "duplicate",
			remaining: 0,
		});
		expect(events.status()).toMatchObject({ open: 0, released: 1, duplicates: 1, contentBytes: 0 });
		expect(await page(compact, routing, lease)).toMatchObject({ success: false });
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 120_000);

it("S13-Q1 (2) leases are count-bounded per peer: past the stated bound the peer gets a typed refusal, and its end frees every lease and its content", async () => {
	const { host, compact, routing } = await compactHost();
	try {
		const events = host.writer.recoveryEvents ?? expect.unreachable("no event lease owner with the flag on");
		const bound = events.peerLimit;
		expect(bound).toBeGreaterThan(0);
		for (let index = 0; index <= bound; index++)
			host.writer.enqueue(routing, oversized(`call-${index}`, String(index % 10).repeat(263_000)));
		await host.writer.flush();
		expect(compact.inbox.filter((record) => leaseOf(record) !== undefined)).toHaveLength(bound);
		expect(compact.inbox.at(-1)).toEqual({ type: "event_lease_refused", sessionId: routing, reason: "lease_limit" });
		expect(events.status()).toMatchObject({ open: bound, refused: { lease_limit: 1 } });
		await host.drop("compact");
		expect(events.status(), "the peer's end releases all its references").toMatchObject({ open: 0, contentBytes: 0 });
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 300_000);

it("S13-Q1 (3) an event lease never extends a checkpoint token's lifetime or pins a superseded root: a newer generation reclaims the token while the lease still reads, and the lease's release leaves the token alone", async () => {
	const { host, compact, routing, lane } = await compactHost();
	try {
		const checkpoints = host.writer.recoveryCheckpoints;
		const socketEpoch = host.writer.socketEpochOf("compact") ?? expect.unreachable();
		const route = {
			socketEpoch,
			admissionId: "attach-s13",
			routeKind: "ordinary" as const,
			peer: "compact",
			sessionId: routing,
		};
		const caller = { socketEpoch, sessionId: routing };
		const first = checkpoints.freeze(route, lane);
		if (!first.ok) throw new Error(`freeze refused: ${JSON.stringify(first.failure)}`);
		host.writer.enqueue(routing, oversized("call-3", "d".repeat(300_000)));
		await host.writer.flush();
		const lease = compact.inbox.map(leaseOf).find((each) => each !== undefined) ?? expect.unreachable();
		const { open, reclaimed } = checkpoints.status();
		const second = checkpoints.freeze(route, lane);
		if (!second.ok) throw new Error(`freeze refused: ${JSON.stringify(second.failure)}`);
		expect(
			checkpoints.status(),
			"the superseded root goes although an event lease of that peer is open",
		).toMatchObject({
			open,
			reclaimed: reclaimed + 1,
		});
		expect(checkpoints.check(first.value.token, caller).ok).toBe(false);
		expect(JSON.parse(await fetchLease(compact, routing, lease))).toMatchObject({ toolCallId: "call-3" });
		expect(dataOf(await release(compact, routing, lease))).toMatchObject({ outcome: "released" });
		expect(checkpoints.check(second.value.token, caller).ok, "the receipt releases no checkpoint").toBe(true);
		checkpoints.release(second.value.token);
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 120_000);

it("T6 X06 golden: with the flag off a compact_events peer receives the complete record, and release_recovery answers as an unknown command", async () => {
	const host = await statusHost();
	try {
		const plain = host.client("plain");
		const routing = String(dataOf(await plain.request({ type: "open_session", cwd: host.cwd })).sessionId);
		const compact = host.client("compact");
		host.writer.setConnectionCapabilities("compact", [COMPACT_EVENTS]);
		host.writer.attachConnectionToSession("compact", routing);
		expect(host.writer.recoveryEvents).toBeUndefined();
		host.writer.enqueue(routing, oversized("call-4", "e".repeat(300_000)));
		await host.writer.flush();
		const full = (client: RawClient) => client.inbox.find((record) => record.type === "tool_execution_end");
		expect(full(compact)).toEqual(full(plain));
		expect(wireBytes(full(compact) ?? expect.unreachable())).toBeGreaterThan(F);
		const lease = { id: "event:socket-1:1", admissionId: "attach-1" } as LeaseRef;
		expect(await release(compact, routing, lease)).toMatchObject({
			success: false,
			error: "Unknown command: release_recovery",
		});
	} finally {
		await host[Symbol.asyncDispose]();
	}
}, 120_000);

it("RULING-63 acceptance: the event lease extends the lease union without reshaping a pre-S13 variant, and its content ref encodes through the S11a codec exactly as a pre-S13 staged ref", async () => {
	expectTypeOf<Extract<RecoveryLease, { kind: "checkpoint" }>>().toEqualTypeOf<CheckpointToken>();
	expectTypeOf<RecoveryToken>().toEqualTypeOf<CheckpointToken>();
	expectTypeOf<EventLease["kind"]>().toEqualTypeOf<"event">();
	expectTypeOf<Extract<FrozenRef, { variant: "staged" }>>().toEqualTypeOf<{
		readonly variant: "staged";
		readonly entry: CatalogEntry;
	}>();
	const { host, compact, routing } = await compactHost();
	const root = await spoolRoot();
	const staging = new TransferStaging(new CompactContentStore({ dir: root.dir }));
	try {
		host.writer.enqueue(routing, oversized("call-5", "f".repeat(300_000)));
		await host.writer.flush();
		const lease = compact.inbox.map(leaseOf).find((each) => each !== undefined) ?? expect.unreachable();
		const text = await fetchLease(compact, routing, lease);
		const staged = staging.stage(protocolId("event"), protocolId(lease.componentRef), text);
		const encode = (entry: CatalogEntry) => {
			const node = new CatalogNodeWriter();
			node.push(entry);
			return node.encode();
		};
		const fromLease = encode({ ...staged.ref.entry, length: lease.length, digest: staged.ref.entry.digest });
		expect(staged.ref.entry.length).toBe(lease.length);
		expect(staged.ref.entry.digest).toBe(lease.digest);
		expect(fromLease).toBe(encode(staged.ref.entry));
		expect(encode(staged.ref.entry)).toBe(
			`{"format":"senpi-recovery-catalog","version":1,"entries":[{"kind":"event","id":"record","length":${lease.length},"digest":"${lease.digest}"}]}`,
		);
		staging.release(staged);
	} finally {
		await staging.close();
		await root.cleanup();
		await host[Symbol.asyncDispose]();
	}
}, 120_000);
