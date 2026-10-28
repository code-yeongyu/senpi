import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { FileEntry } from "../../../src/core/session-manager.ts";
import { checkpointComponents } from "../../../src/modes/rpc/compact-catalog-families.ts";
import {
	CATALOG_FAMILIES,
	ENTRY_FAMILIES,
	FAMILY_PRODUCERS,
	entryFamily,
} from "../../../src/modes/rpc/compact-catalog-registry.ts";
import type { CatalogRead } from "../../../src/modes/rpc/compact-recovery-catalog.ts";
import type { RecoveryRoute } from "../../../src/modes/rpc/compact-recovery-state.ts";
import type { RecoveryOutcome } from "../../../src/modes/rpc/compact-recovery-types.ts";
import { CompactValues } from "../../../src/modes/rpc/compact-values.ts";
import { SessionAcceptanceLane } from "../../../src/modes/rpc/session-acceptance-lane.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { memoryIo, spoolRoot } from "../compact-storage-support.ts";
import { componentText } from "./4272-frozen-bytes-support.ts";
import { cutStructuredBytes, recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S10a, R4.B2, RULING-60): every checkpoint family has a typed registry entry and an explicit catalog
// component; the transcript, run, lifecycle and dialog adapters feed the real catalog builder through bounded leaves;
// an engine entry of unknown kind is kept whole in the opaque family; run state and dialog counts are in the digest.

afterEach(() => {
	vi.restoreAllMocks();
});

const MiB = 1024 * 1024;
const caller = { socketEpoch: "socket-1", sessionId: "s" };
const route = (): RecoveryRoute => ({
	socketEpoch: "socket-1",
	admissionId: "attach-1",
	routeKind: "ordinary",
	peer: "peer",
	sessionId: "s",
});

function unwrap<T>(outcome: RecoveryOutcome<T>): T {
	if (!outcome.ok) throw new Error(`refused: ${JSON.stringify(outcome.failure)}`);
	return outcome.value;
}
const node = (read: CatalogRead) => (read.kind === "node" ? read : expect.unreachable("expected a node"));
const component = (read: CatalogRead) =>
	read.kind === "component" ? read : expect.unreachable("expected a component");
const ref = (root: string, index: number) => `${root}:${String(index).padStart(3, "0")}`;
const sha256 = (text: string) => createHash("sha256").update(Buffer.from(text, "utf16le")).digest("hex");

/** The root node's entries as `[kind, id]` and a reader of the component text at one index. */
async function catalogOf(rig: ReturnType<typeof recoveryRig>) {
	await rig.lane.idle();
	const token = unwrap(rig.checkpoints.freeze(route(), rig.lane)).token;
	const manifest = unwrap(await rig.checkpoints.catalog(token, caller));
	const root = node(unwrap(await rig.checkpoints.readCatalog(token, caller, manifest.catalogRoot)));
	const entries = root.entries.map((entry) => [entry.kind, entry.id] as const);
	const text = async (kind: string, id: string) => {
		const index = entries.findIndex(([k, i]) => k === kind && i === id);
		expect(index, `${kind}/${id} is cataloged`).toBeGreaterThanOrEqual(0);
		const read = component(
			unwrap(await rig.checkpoints.readCatalog(token, caller, ref(manifest.catalogRoot, index))),
		);
		return { ...read, text: await componentText(read) };
	};
	return { token, manifest, root, entries, text };
}

const append = (entry: { type: string; id: string; parentId: string | null; timestamp: string }, id: string) => ({
	kind: "append" as const,
	id,
	type: entry.type,
	parentId: entry.parentId,
	entry: JSON.stringify(entry),
});

it("X03 T1 every family of the versioned schema has a registry row and an explicit component; the producer assembly is complete once every family is", async () => {
	const rig = recoveryRig();
	rig.lane.accept({ type: "session_lifecycle", sessionId: "s", lifecycle: { phase: "ready" } }, undefined);
	const { token, entries, text, manifest } = await catalogOf(rig);
	expect(entries).toEqual([
		["families", "families"],
		["transcript", "transcript"],
		["opaque", "opaque"],
		["run", "run"],
		["lifecycle", "lifecycle"],
		["dialogs", "dialogs"],
		["active", "message-0000000000000000"],
		["calls", "calls"],
		["settled", "settled"],
		["identity", "identity"],
		["source", "source"],
	]);
	const registry = JSON.parse((await text("families", "families")).text);
	expect(registry).toEqual({
		format: "senpi-recovery-families",
		version: 1,
		assembly: "complete",
		families: CATALOG_FAMILIES.map((family) => ({ family, producer: "complete" })),
	});
	expect(FAMILY_PRODUCERS).toEqual(Object.fromEntries(CATALOG_FAMILIES.map((family) => [family, "complete"])));
	expect(JSON.parse((await text("transcript", "transcript")).text)).toEqual({
		historyVersion: 0,
		leafId: null,
		count: 0,
		base: null,
		persisted: null,
		unavailable: null,
	});
	expect(JSON.parse((await text("run", "run")).text)).toEqual({
		runState: "idle",
		dialogCounts: { broadcast: 0, targeted: 0 },
	});
	expect(JSON.parse((await text("lifecycle", "lifecycle")).text)).toEqual({
		type: "session_lifecycle",
		sessionId: "s",
		lifecycle: { phase: "ready" },
	});
	for (const [kind, id] of [
		["opaque", "opaque"],
		["dialogs", "dialogs"],
		["calls", "calls"],
		["settled", "settled"],
		["source", "source"],
	] as const) {
		const empty = await text(kind, id);
		expect(empty.text, `${kind} is explicitly empty, never omitted`).toBe("");
		expect(empty.entry.length).toBe(0);
	}
	expect(manifest.checkpointDigest).toMatch(/^[0-9a-f]{64}$/);
	rig.checkpoints.release(token);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});

it("RULING-60 carry 44: a cut differing only in run state, or only in dialog counts, has another checkpoint digest", async () => {
	const rig = recoveryRig();
	rig.lane.accept({ type: "agent_end", messages: [] }, undefined);
	const idle = await catalogOf(rig);
	const idleRun = JSON.parse((await idle.text("run", "run")).text);
	expect(idleRun).toEqual({ runState: "idle", dialogCounts: { broadcast: 0, targeted: 0 } });
	rig.lane.accept({ type: "agent_start" }, undefined);
	const running = await catalogOf(rig);
	expect(running.root.entries.map((entry) => [entry.kind, entry.id])).toEqual(
		idle.root.entries.map((entry) => [entry.kind, entry.id]),
	);
	expect(JSON.parse((await running.text("run", "run")).text).runState).toBe("running");
	expect(running.manifest.checkpointDigest, "run state is in the digest").not.toBe(idle.manifest.checkpointDigest);
	const changed = running.root.entries.filter((entry, index) => entry.digest !== idle.root.entries[index]?.digest);
	expect(
		changed.map((entry) => entry.id),
		"only the run component and the identity's sequence changed",
	).toEqual(["run", "identity"]);
	rig.lane.accept(
		{ type: "extension_ui_request", method: "select", id: "t1", title: "secret", options: [] },
		undefined,
	);
	const targeted = await catalogOf(rig);
	expect(JSON.parse((await targeted.text("run", "run")).text)).toEqual({
		runState: "running",
		dialogCounts: { broadcast: 0, targeted: 1 },
	});
	const run = (catalog: typeof idle) => catalog.root.entries.find((entry) => entry.id === "run")?.digest;
	expect(run(targeted), "dialog counts are in the run component's digest").not.toBe(run(running));
	expect(targeted.manifest.checkpointDigest).not.toBe(running.manifest.checkpointDigest);
	expect(JSON.parse((await targeted.text("dialogs", "dialog-0000000000000000")).text)).toEqual({
		id: "t1",
		audience: "targeted",
		method: "select",
	});
	for (const { token } of [idle, running, targeted]) rig.checkpoints.release(token);
	expect(rig.lane.liveRoots).toBe(0);
	await rig.lane.idle();
});

it("RULING-60 Q1 (1)(2) every accepted entry is cataloged under its engine kind's family in order with its parent link; an unknown kind is an opaque component with its data retained", async () => {
	const rig = recoveryRig();
	const message: FileEntry = {
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: "t1",
		message: { role: "user", content: "hi", timestamp: 1 },
	};
	const custom: FileEntry = { type: "custom", id: "e2", parentId: "e1", timestamp: "t2", customType: "plan", data: 1 };
	const label: FileEntry = { type: "label", id: "e3", parentId: "e2", timestamp: "t3", targetId: "e1", label: "x" };
	const unknown = {
		type: "ext_timeline_group",
		id: "e4",
		parentId: "e3",
		timestamp: "t4",
		group: { title: "\u{1F600} group", members: ["e1", "e2"] },
	};
	const persistence = { fileIdentity: { path: "/nowhere/s.jsonl", dev: "1", ino: "1" }, count: 1 };
	rig.lane.applyTranscript([
		{ kind: "append", id: "e0", type: "message", parentId: null, persistence },
		append(message, "e1"),
		append(custom, "e2"),
		append(label, "e3"),
		append(unknown, "e4"),
	]);
	rig.lane.applyTranscript([{ kind: "leaf", leafId: "e4" }]);
	const { token, entries, text } = await catalogOf(rig);
	expect(entries.slice(0, 8)).toEqual([
		["families", "families"],
		["transcript", "transcript"],
		["transcript", "entry-0000000000000000"],
		["transcript", "entry-0000000000000001"],
		["transcript", "entry-0000000000000002"],
		["transcript", "entry-0000000000000003"],
		["transcript", "entry-0000000000000004"],
		["opaque", "entry-0000000000000004"],
	]);
	expect(entries.filter(([kind]) => kind === "source").map(([, id]) => id)).toEqual([
		"entry-0000000000000002",
		"entry-0000000000000003",
	]);
	expect(JSON.parse((await text("transcript", "transcript")).text)).toEqual({
		historyVersion: 6,
		leafId: "e4",
		count: 5,
		base: null,
		persisted: 1,
		unavailable: null,
	});
	const rows = await Promise.all(
		[0, 1, 2, 3, 4].map(async (n) =>
			JSON.parse((await text("transcript", `entry-${String(n).padStart(16, "0")}`)).text),
		),
	);
	expect(rows).toEqual([
		{ index: 0, id: "e0", source: "file", parentId: null, kind: "message", family: "transcript" },
		{ index: 1, id: "e1", source: "tail", parentId: null, kind: "message", family: "transcript" },
		{ index: 2, id: "e2", source: "tail", parentId: "e1", kind: "custom", family: "source" },
		{ index: 3, id: "e3", source: "tail", parentId: "e2", kind: "label", family: "source" },
		{ index: 4, id: "e4", source: "tail", parentId: "e3", kind: "ext_timeline_group", family: "opaque" },
	]);
	expect((await text("opaque", "entry-0000000000000004")).text, "the exact retained line, never dropped").toBe(
		JSON.stringify(unknown),
	);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("RULING-60 Q1 (1) the engine source-kind mapping is total over FileEntry['type'] and every family is a registry row", () => {
	const kinds = [
		"session",
		"message",
		"thinking_level_change",
		"configuration_update",
		"model_change",
		"model_change_rejected",
		"usage",
		"compaction",
		"branch_summary",
		"custom",
		"custom_message",
		"context_edit",
		"label",
		"session_info",
	];
	expect(Object.keys(ENTRY_FAMILIES).sort()).toEqual([...kinds].sort());
	for (const kind of kinds) expect(CATALOG_FAMILIES).toContain(entryFamily(kind));
	expect(entryFamily("session")).toBe("transcript");
	expect(entryFamily("message")).toBe("transcript");
	expect(entryFamily("compaction")).toBe("source");
	expect(entryFamily("ext_timeline_group"), "an unknown kind maps to the opaque family").toBe("opaque");
	expect(entryFamily("constructor"), "lookup is by own key, not the prototype").toBe("opaque");
	expect(Object.keys(FAMILY_PRODUCERS).sort()).toEqual([...CATALOG_FAMILIES].sort());
});

it("X03 an unavailable transcript is an explicit root with its typed reason and no entry rows, never an omission", async () => {
	const rig = recoveryRig();
	rig.lane.applyTranscript([append({ type: "message", id: "e1", parentId: null, timestamp: "t" }, "e1")]);
	rig.lane.applyTranscript([{ kind: "unavailable", reason: "transcript_tail_trimmed" }]);
	const { token, entries, text } = await catalogOf(rig);
	expect(JSON.parse((await text("transcript", "transcript")).text)).toEqual({
		historyVersion: 2,
		leafId: "e1",
		count: 1,
		base: null,
		persisted: null,
		unavailable: "transcript_tail_trimmed",
	});
	expect(entries.filter(([kind]) => kind === "transcript")).toEqual([["transcript", "transcript"]]);
	rig.checkpoints.release(token);
	await rig.lane.idle();
});

it("RULING-59 X02 a broadcast question holding a 34 MiB string streams through the dialogs adapter with one value page resident, in bounded leaves, as the exact canonical JSON of the dialog", async () => {
	const spool = await spoolRoot();
	const lane = new SessionAcceptanceLane({ dir: spool.dir, io: memoryIo() });
	const writer = new SessionEventWriter(() => {});
	lane.bootstrap({ transcript: [] });
	writer.registerAcceptance("s", lane);
	const checkpoints = writer.recoveryCheckpoints;
	// 17 Mi code units: over the old 16 MiB cap; the leading "a" splits a surrogate pair at every page edge.
	const body = `a${"\u{1F600}".repeat((17 * MiB - 1) / 2)}`;
	const request = { type: "extension_ui_request", method: "question", id: "q1", deadlineAtMs: 10, body };
	try {
		lane.accept(request, undefined);
		await lane.idle();
		const probe = lane.freeze();
		const baseline = await cutStructuredBytes(lane, probe);
		const expected = JSON.stringify({
			id: "q1",
			audience: "broadcast",
			method: "question",
			deadlineAtMs: 10,
			request,
		});
		const settled = lane.settledOf(probe);
		const measured = await lane.cutStorage(probe, async (store, valid) => {
			const values = new CompactValues(store);
			const seen: string[] = [];
			let leaves = 0;
			let maxUnits = 0;
			let digest = "";
			let length = 0;
			for await (const part of checkpointComponents({ store, values, root: probe, settled }, valid)) {
				seen.push(`${part.kind}/${part.id}`);
				if (part.kind !== "dialogs") continue;
				const hash = createHash("sha256");
				for (const leaf of part.leaves) {
					const text = await store.readLeaf(leaf);
					leaves++;
					maxUnits = Math.max(maxUnits, text.length);
					length += text.length;
					hash.update(Buffer.from(text, "utf16le"));
				}
				digest = hash.digest("hex");
				expect(values.residentPages, "no value page is held between components").toBe(0);
			}
			return { seen, leaves, maxUnits, digest, length, peak: values.peakResidentPages };
		});
		expect(measured.seen).toContain("dialogs/dialog-0000000000000000");
		expect(measured.peak, "one value page resident while the dialog streams").toBe(1);
		expect(measured.maxUnits).toBeLessThanOrEqual(32_768);
		expect(measured.leaves).toBeGreaterThanOrEqual(expected.length / 32_768);
		expect(measured.length).toBe(expected.length);
		expect(measured.digest).toBe(sha256(expected));
		await lane.idle();
		expect(await cutStructuredBytes(lane, probe), "every adapter leaf released after its component").toEqual(
			baseline,
		);
		const token = unwrap(checkpoints.freeze(route(), lane)).token;
		const manifest = unwrap(await checkpoints.catalog(token, caller));
		const root = node(unwrap(await checkpoints.readCatalog(token, caller, manifest.catalogRoot)));
		const dialog = root.entries.find((entry) => entry.id === "dialog-0000000000000000");
		expect(dialog?.length, "the catalog digests the same stored bytes").toBe(expected.length * 2);
		checkpoints.release(token);
		await lane.idle();
		expect(await cutStructuredBytes(lane, probe), "the catalog and its leaves go with the token").toEqual(baseline);
		lane.release(probe);
	} finally {
		lane.retire("close");
		await lane.idle();
		await spool.cleanup();
	}
}, 180_000);
