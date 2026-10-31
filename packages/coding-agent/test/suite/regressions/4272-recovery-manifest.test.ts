import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { CatalogEntry } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import { CompactContentStore } from "../../../src/modes/rpc/compact-content-store.ts";
import type { CatalogRead } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import type { RecoveryManifest } from "../../../src/modes/rpc/compact-recovery-manifest.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { serializeJsonLine } from "../../../src/modes/rpc/jsonl.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { controlledIo, spoolRoot } from "../compact-storage-support.ts";
import { cutStructuredBytes, recoveryRig, streaming } from "./4272-recovery-support.ts";

// Part of #4272 (S09, R4.B1, X03/X04/T5): the manifest names a frozen checkpoint and its catalog root with bounded
// protocol ids only; an arbitrary id becomes a content ref whose original value reads back exactly; selection stays
// unavailable (no transport) and the rollout flag stays off.

afterEach(() => {
	vi.restoreAllMocks();
});

const route = (sessionId = "s", socketEpoch = "socket-1"): RecoveryRoute => ({
	socketEpoch,
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId,
});

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}

/** The written spec of `compact-catalog-codec.ts`, restated here so no expected value comes from the encoder. */
const specDigest = (domain: "leaf" | "node" | "root", bytes: Buffer): string => {
	const tag = Buffer.from(`senpi-recovery-catalog/1/utf16le/${domain}`, "ascii");
	const length = Buffer.alloc(8);
	length.writeBigUInt64BE(BigInt(bytes.length));
	return createHash("sha256")
		.update(Buffer.from([tag.length]))
		.update(tag)
		.update(length)
		.update(bytes)
		.digest("hex");
};
const specNode = (entries: readonly CatalogEntry[]) =>
	`{"format":"senpi-recovery-catalog","version":1,"entries":[${entries
		.map((e) => `{"kind":"${e.kind}","id":"${e.id}","length":${e.length},"digest":"${e.digest}"}`)
		.join(",")}]}`;

const node = (read: CatalogRead) => (read.kind === "node" ? read : expect.unreachable("expected a node"));
const component = (read: CatalogRead) =>
	read.kind === "component" ? read : expect.unreachable("expected a component");

it("T1 X03 X04 the manifest names the cut and its catalog root with bounded ids; a huge Unicode session id becomes a ref whose exact value reads back; the line fits M", async () => {
	const rig = recoveryRig();
	const huge = `${"\u{1F600}세션/..\\".repeat(20_000)}\0end`;
	const caller = { socketEpoch: "socket-1", sessionId: huge };
	await rig.lane.idle();
	const token = unwrap(rig.checkpoints.freeze(route(huge), rig.lane)).token;
	const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
	expect(manifest).toMatchObject({
		format: "senpi-recovery-manifest",
		version: 1,
		socketEpoch: { id: "socket-1" },
		admissionId: { id: "attach-1" },
		routeKind: "ordinary",
		sessionEpoch: { id: rig.lane.sessionEpoch },
		generation: 1,
		sequence: token.cut.sequence,
		historyVersion: token.cut.historyVersion,
		token: { id: token.id },
		leaf: null,
		catalogRoot: "c-0000000000000001",
	});
	expect(manifest.activeMessage).toEqual({ id: token.cut.activeMessageId });
	expect(manifest.turn).toEqual({ id: token.cut.turnId });
	const line = serializeJsonLine({ type: "recovery_manifest", manifest });
	expect(Buffer.byteLength(line)).toBeLessThanOrEqual(65_536);
	expect(line).not.toContain("\u{1F600}");
	if (!("ref" in manifest.session)) throw new Error("the huge session id must be a ref");
	expect(manifest.session.length).toBe(Buffer.byteLength(huge, "utf16le"));
	expect(manifest.session.digest).toBe(specDigest("leaf", Buffer.from(huge, "utf16le")));
	const text = component(unwrap(await rig.checkpoints.readCatalog(token, caller, manifest.session.ref)));
	expect(text.text).toBe(huge);
	expect(text.entry).toMatchObject({ kind: "manifest", id: "session" });
	const root = node(unwrap(await rig.checkpoints.readCatalog(token, caller, manifest.catalogRoot)));
	expect(root.entries.map((entry) => [entry.kind, entry.id])).toEqual([
		["manifest", "session"],
		["families", "families"],
		["transcript", "transcript"],
		["opaque", "opaque"],
		["run", "run"],
		["lifecycle", "lifecycle"],
		["dialogs", "dialogs"],
		["active", "active"],
		["calls", "calls"],
		["settled", "settled"],
	]);
	for (const entry of root.entries) expect(Buffer.byteLength(entry.id)).toBeLessThanOrEqual(128);
	expect(manifest.checkpointDigest).toBe(specDigest("root", Buffer.from(specNode(root.entries), "utf16le")));
	expect(manifest.catalogRootLength).toBe(root.length);
	expect(root.digest).toBe(manifest.checkpointDigest);
	const active = component(unwrap(await rig.checkpoints.readCatalog(token, caller, `${manifest.catalogRoot}:007`)));
	expect(active.entry.length).toBe(Buffer.byteLength(active.text, "utf16le"));
	expect(JSON.parse(active.text), "the exact stored root page of the active-message index").toMatchObject({
		key: { value: "0000000000000000" },
	});
	expect(unwrap(await rig.checkpoints.catalog(token, caller)), "built once per token").toBe(manifest);
	rig.checkpoints.release(token);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});

it("RULING-57 Q2 (2) a bounded routing session id stays inline, a null leaf/turn stays null, and the refusal path keeps the typed shape", async () => {
	const rig = recoveryRig();
	const token = unwrap(rig.checkpoints.freeze(route(), rig.lane)).token;
	const manifest = unwrap(await rig.checkpoints.catalog(token, { socketEpoch: "socket-1", sessionId: "s" }));
	expect(manifest.session).toEqual({ id: "s" });
	expect(manifest.leaf).toBeNull();
	expect(await rig.checkpoints.catalog(token, { socketEpoch: "socket-2", sessionId: "s" })).toEqual({
		ok: false,
		failure: { kind: "repair_needed", reason: "unknown_token" },
	});
	expect(
		await rig.checkpoints.readCatalog(token, { socketEpoch: "socket-1", sessionId: "s" }, "c-0000000000000009"),
	).toEqual({ ok: false, failure: { kind: "storage_unavailable", reason: "range" } });
	expect(await rig.checkpoints.readCatalog(token, { socketEpoch: "socket-1", sessionId: "s" }, "../etc")).toEqual({
		ok: false,
		failure: { kind: "storage_unavailable", reason: "range" },
	});
	expect(rig.checkpoints.status().unavailable, "range counted apart from integrity").toEqual({ range: 2 });
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("RULING-57 Q1 (3) a flipped byte in the stored root node is a typed integrity refusal through the token, never a decode", async () => {
	const rig = recoveryRig();
	const caller = { socketEpoch: "socket-1", sessionId: "s" };
	const token = unwrap(rig.checkpoints.freeze(route(), rig.lane)).token;
	const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
	const original = CompactContentStore.prototype.readLeaf;
	vi.spyOn(CompactContentStore.prototype, "readLeaf").mockImplementationOnce(async function (
		this: CompactContentStore,
		id,
	) {
		return (await original.call(this, id)).replace('"version":1', '"version":2');
	});
	const refusal = await rig.checkpoints.readCatalog(token, caller, manifest.catalogRoot);
	expect(refusal).toEqual({ ok: false, failure: { kind: "storage_unavailable", reason: "integrity" } });
	// RULING-58 (2): the refusal carries no stored bytes and no partial decode, only its kind and typed detail.
	expect(Object.keys(refusal)).toEqual(["ok", "failure"]);
	expect(refusal.ok ? [] : Object.keys(refusal.failure)).toEqual(["kind", "reason"]);
	expect(JSON.stringify(refusal)).not.toMatch(/senpi-recovery-catalog|[0-9a-f]{64}/);
	expect(rig.checkpoints.status().refused).toEqual({ storage_unavailable: 1 });
	expect(rig.checkpoints.status().unavailable, "integrity is the corruption signal").toEqual({ integrity: 1 });
	expect(node(unwrap(await rig.checkpoints.readCatalog(token, caller, manifest.catalogRoot))).digest).toBe(
		manifest.checkpointDigest,
	);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("T5 X04 a token superseded while its first catalog read is held publishes nothing and releases its construction; a surviving token keeps its digest across later records", async () => {
	const root = await spoolRoot();
	const control = controlledIo();
	const writer = new SessionEventWriter(() => {});
	const lane = new SessionAcceptanceLane({ dir: root.dir, io: control.io });
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const producer = streaming(writer, lane);
	const checkpoints = writer.recoveryCheckpoints;
	const caller = (socketEpoch: string) => ({ socketEpoch, sessionId: "s" });
	const probe = lane.freeze();
	const live = async () => {
		await lane.idle();
		const bytes = await cutStructuredBytes(lane, probe);
		return bytes.resident + bytes.spilled;
	};
	try {
		const before = await live();
		const first = unwrap(checkpoints.freeze(route("s", "socket-1"), lane)).token;
		const survivor = unwrap(checkpoints.freeze(route("s", "socket-2"), lane)).token;
		const held = control.hold("read");
		const building = checkpoints.catalog(first, caller("socket-1"));
		await held.entered;
		const second = unwrap(checkpoints.freeze(route("s", "socket-1"), lane)).token;
		held.release();
		expect(await building).toEqual({
			ok: false,
			failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 2 },
		});
		expect(await live(), "the superseded build left no node or pointer leaf in the cut's store").toBe(before);
		const manifest = unwrap(await checkpoints.catalog(survivor, caller("socket-2")));
		const catalogBytes = (await live()) - before;
		expect(catalogBytes).toBeGreaterThan(0);
		for (let offset = 0; offset < 50; offset++) producer.blockDelta("text", 0, "later", offset * 5);
		const afterDeltas = await live();
		expect(unwrap(await checkpoints.catalog(survivor, caller("socket-2")))).toBe(manifest);
		const again = node(unwrap(await checkpoints.readCatalog(survivor, caller("socket-2"), manifest.catalogRoot)));
		expect(again.digest).toBe(manifest.checkpointDigest);
		const same = unwrap(await checkpoints.catalog(second, caller("socket-1")));
		expect(same.checkpointDigest, "the same frozen content under another token: the same digest").toBe(
			manifest.checkpointDigest,
		);
		const third = unwrap(checkpoints.freeze(route("s", "socket-1"), lane)).token;
		const later = unwrap(await checkpoints.catalog(third, caller("socket-1")));
		expect(later.checkpointDigest, "a cut after the deltas names other bytes").not.toBe(manifest.checkpointDigest);
		expect(await checkpoints.catalog(second, caller("socket-1"))).toEqual({
			ok: false,
			failure: { kind: "repair_needed", reason: "superseded_token", newerGeneration: 3 },
		});
		checkpoints.release(survivor);
		checkpoints.release(third);
		expect(lane.liveRoots).toBe(1);
		expect(await live(), "every catalog owner released with its token").toBe(afterDeltas - catalogBytes);
	} finally {
		lane.release(probe);
		lane.retire("close");
		await lane.idle();
		await root.cleanup();
	}
});

it("X03 the manifest never lists components: its size is independent of the component count", async () => {
	const rig = recoveryRig();
	const caller = { socketEpoch: "socket-1", sessionId: "s" };
	const token = unwrap(rig.checkpoints.freeze(route(), rig.lane)).token;
	const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
	const keys = Object.keys(manifest).sort();
	expect(keys).toEqual(
		[
			"activeMessage",
			"admissionId",
			"catalogRoot",
			"catalogRootLength",
			"checkpointDigest",
			"format",
			"generation",
			"historyVersion",
			"leaf",
			"routeKind",
			"sequence",
			"session",
			"sessionEpoch",
			"socketEpoch",
			"token",
			"turn",
			"version",
		].sort(),
	);
	const sized: RecoveryManifest = manifest;
	expect(Buffer.byteLength(JSON.stringify(sized))).toBeLessThan(2_048);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});
