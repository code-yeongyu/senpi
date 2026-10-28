import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";
import type { FileEntry } from "../../../src/core/session-manager.ts";
import { recoveryCarrier } from "../../../src/core/session-recovery-identity.ts";
import {
	assertCoverage,
	CATALOG_FAMILIES,
	type CatalogFamily,
	completeAssembly,
	FAMILY_PRODUCERS,
	familyRegistry,
	readFamilyRegistry,
} from "../../../src/modes/rpc/compact-catalog-registry.ts";
import { CompactReadError } from "../../../src/modes/rpc/compact-read-lease.ts";
import { callsRig } from "./4272-calls-support.ts";
import { catalogOf, entryMember, memberOf, produced } from "./4272-catalog-read-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S10b, R4.B2, RULING-60/61): the message, call, identity and source-metadata adapters enumerate every
// member of their family as canonical JSON with no storage id inside, the producer assembly is complete only when every
// family is, and a catalog missing a complete-producer family is refused (X03), never published as complete.

afterEach(() => {
	vi.restoreAllMocks();
});

it("X03 T1 every family is enumerated by a complete producer and the registry narrows to a complete assembly only through completeAssembly", async () => {
	// Given: a fresh epoch streaming one assistant message, with a lifecycle record accepted
	const rig = recoveryRig();
	rig.lane.accept({ type: "session_lifecycle", sessionId: "s", lifecycle: { phase: "ready" } }, undefined);
	rig.producer().blockDelta("text", 0, "hello", 0);
	// When: its catalog is built through the manifest path and the registry is read by the one decoder
	const catalog = await catalogOf(rig);
	const registry = readFamilyRegistry((await catalog.text("families", "families")).text);
	// Then: every producer is complete, the assembly is complete, and every family has at least one component
	expect(FAMILY_PRODUCERS).toEqual(Object.fromEntries(CATALOG_FAMILIES.map((family) => [family, "complete"])));
	expect(registry.assembly).toBe("complete");
	const narrowed = completeAssembly(registry);
	expect(narrowed?.families.map(({ producer }) => producer)).toEqual(CATALOG_FAMILIES.map(() => "complete"));
	const kinds = new Set<string>(catalog.entries.map(([kind]) => kind));
	expect(
		[...CATALOG_FAMILIES].filter((family) => !kinds.has(family)),
		"no family is omitted",
	).toEqual([]);
	expect(catalog.entries.map(([kind, id]) => `${kind}/${id}`)).toContain(`active/${memberOf("message", 0)}`);
	for (const family of ["calls", "settled", "source"] as const) {
		const empty = await catalog.text(family, family);
		expect(empty.text, `${family} is explicitly empty, never omitted`).toBe("");
	}
	expect(await catalog.json("identity", "identity")).toMatchObject({
		activeMessageId: "message-1",
		turnId: expect.any(String),
		correlation: null,
	});
	catalog.release();
	await rig.lane.idle();
});

it("X03 omitting any complete-producer family in turn refuses the assembly; an explicit empty component is accepted", () => {
	// Given: a registry whose every producer is complete
	const registry = familyRegistry(FAMILY_PRODUCERS);
	const every = new Set<string>(CATALOG_FAMILIES);
	// Then: with every family present (an explicit empty counts) the gate accepts, and each omission is refused typed
	expect(() => assertCoverage(registry, every)).not.toThrow();
	for (const family of CATALOG_FAMILIES) {
		const without = new Set(every);
		without.delete(family);
		expect(() => assertCoverage(registry, without), `${family} omitted`).toThrow(CompactReadError);
	}
	// And: a partial family (the loaded base S11 streams) may emit nothing without failing the gate
	const partial = familyRegistry({ ...FAMILY_PRODUCERS, transcript: "partial", opaque: "partial", source: "partial" });
	const base = new Set<CatalogFamily>(CATALOG_FAMILIES.filter((family) => family !== "opaque"));
	expect(() => assertCoverage(partial, base)).not.toThrow();
	expect(completeAssembly(partial)).toBeUndefined();
});

it("RULING-61 Q2 the source family enumerates every this-epoch source entry with its retained line and settled join; a loaded base is named by its base member", async () => {
	// Given: a toolResult message settled and joined to a custom_message entry, plus a compaction entry and a label
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start" });
		rig.record({ type: "tool_execution_start", toolCallId: "c1", toolName: "read", args: {} });
		rig.record({ type: "tool_execution_end", toolCallId: "c1", toolName: "read", result: "r", isError: false });
		const carrier = rig.toolResult("c1", "read", "done");
		const custom: FileEntry = {
			type: "custom_message",
			id: "e1",
			parentId: null,
			timestamp: "t1",
			customType: "x",
			content: "c",
			display: false,
		};
		const compaction = { type: "compaction", id: "e2", parentId: "e1", timestamp: "t2", summary: "s" };
		rig.lane.applyTranscript([
			{
				kind: "append",
				id: "e1",
				type: "custom_message",
				parentId: null,
				entry: JSON.stringify(custom),
				owningMessageId: carrier.messageId,
				recoveryEpoch: carrier.epoch,
			},
			{ kind: "append", id: "e2", type: "compaction", parentId: "e1", entry: JSON.stringify(compaction) },
			{ kind: "append", id: "e3", type: "message", parentId: "e2" },
		]);
		await rig.lane.idle();
		const root = rig.lane.freeze();
		// When: the cut is cataloged
		const { texts } = await produced(rig.lane, root);
		// Then: each source entry is a member carrying its exact line and the message it joined; the message entry is not
		// (the journal's session header sits at index 0)
		expect(JSON.parse(texts.get(`source/${entryMember(1)}`) ?? "")).toEqual({
			index: 1,
			id: "e1",
			parentId: null,
			kind: "custom_message",
			messageId: carrier.messageId,
			entry: custom,
		});
		expect(JSON.parse(texts.get(`source/${entryMember(2)}`) ?? "")).toEqual({
			index: 2,
			id: "e2",
			parentId: "e1",
			kind: "compaction",
			messageId: null,
			entry: compaction,
		});
		expect(texts.has(`source/${entryMember(3)}`)).toBe(false);
		expect(texts.has("source/source")).toBe(false);
		// And: the join is an identity member and the settled terminal left with it
		expect(JSON.parse(texts.get(`identity/${memberOf("join", 0)}`) ?? "")).toEqual({
			messageId: carrier.messageId,
			entryId: "e1",
		});
		expect(texts.get("settled/settled")).toBe("");
		const registry = readFamilyRegistry(texts.get("families/families") ?? "");
		expect(registry.assembly).toBe("complete");
		rig.lane.release(root);
		// Given: the next epoch loads a base of persisted entries
		rig.lane.bootstrap({
			transcript: [
				{
					kind: "replace",
					base: { fileIdentity: { path: "/nowhere/s.jsonl", dev: "1", ino: "1" }, count: 2, idFingerprint: "f" },
				},
			],
		});
		const loaded = rig.lane.freeze();
		// Then: source names the base stream S11c pages (like transcript and opaque), is never explicitly empty, and the
		// assembly is complete
		const base = await produced(rig.lane, loaded);
		expect(base.texts.has("source/source")).toBe(false);
		expect(JSON.parse(base.texts.get("source/base") ?? "")).toEqual({
			source: "file",
			first: 0,
			count: 2,
			idFingerprint: "f",
		});
		expect(readFamilyRegistry(base.texts.get("families/families") ?? "").assembly).toBe("complete");
		rig.lane.release(loaded);
	} finally {
		await rig.close();
	}
});

it("carry 47: a correlated record refused at the protocol depth limit leaves the standing correlation at its own sequence, which the identity member reports beside the root's", async () => {
	// Given: a standing correlation, then a correlated custom message_end nested past the protocol depth limit
	const rig = await callsRig();
	try {
		rig.record({ type: "turn_start", clientMessageId: "c1", clientTurnId: "t1" });
		rig.record({ type: "turn_end" });
		let deep: unknown = "leaf";
		for (let depth = 0; depth < 1_100; depth++) deep = [deep];
		const refused = rig.lane.accept(
			{ type: "message_end", clientMessageId: "c2", message: { role: "custom", content: deep, timestamp: 1 } },
			undefined,
		);
		await rig.lane.idle();
		const root = rig.lane.freeze();
		// When: the cut is cataloged
		const { texts } = await produced(rig.lane, root);
		// Then: the record took a sequence but the correlation stayed, and the member says at which sequence it stood
		expect(refused?.sequence).toBe(root.sequence);
		expect(JSON.parse(texts.get("identity/identity") ?? "")).toEqual({
			sessionEpoch: root.sessionEpoch,
			sequence: root.sequence,
			activeMessageId: null,
			turnId: null,
			correlation: { sequence: 1, clientMessageId: "c1", clientTurnId: "t1" },
			refusedCorrelations: 1,
		});
		expect(root.correlation?.sequence).toBeLessThan(root.sequence);
		// And: a reader knows a correlation is missing: the identity family is partial (RULING-67 (4))
		const registry = readFamilyRegistry(texts.get("families/families") ?? "");
		expect(registry.assembly === "incomplete" ? registry.incomplete : []).toEqual(["identity"]);
		rig.lane.release(root);
	} finally {
		await rig.close();
	}
});

it("RULING-67 (4) the record after one refused at the protocol depth limit correlates to its own turn and message, never the refused one's", async () => {
	// Given: a correlated turn with a live assistant message whose correlated end is refused at the protocol depth limit
	const rig = await callsRig();
	try {
		const turn = rig.record({ type: "turn_start", clientMessageId: "c1", clientTurnId: "t1" });
		const first = rig.start();
		let deep: unknown = "leaf";
		for (let depth = 0; depth < 1_100; depth++) deep = [deep];
		const message = { ...fauxAssistantMessage("", { timestamp: 1 }), content: [{ type: "text", text: deep }] };
		const refusedEnd = { type: "message_end", clientMessageId: "c2", clientTurnId: "t1", message };
		const refused = rig.lane.accept(refusedEnd, first);
		const stale = rig.lane.freeze();
		// When: the next record of the same turn starts a second message with its own correlation
		const next = {
			type: "message_start",
			message: fauxAssistantMessage("", { timestamp: 2 }),
			clientMessageId: "c3",
			clientTurnId: "t1",
		};
		rig.producer.observe(next);
		const second = recoveryCarrier(next) ?? expect.unreachable("producer failed to mint");
		const accepted = rig.lane.accept(next, second);
		await rig.lane.idle();
		const root = rig.lane.freeze();
		// Then: the refused end kept its turn and left no stale active message or correlation behind
		expect(rig.lane.storageStatus().refusedRecords).toBe(1);
		expect(refused).toMatchObject({ turnId: turn?.turnId, messageId: first.messageId });
		expect(stale).toMatchObject({ activeMessageId: null, correlation: { clientMessageId: "c1" } });
		// And: the next record is its own message in the same turn, under its own correlation
		expect(accepted).toMatchObject({ turnId: turn?.turnId, messageId: second.messageId });
		expect(root).toMatchObject({
			turnId: turn?.turnId,
			activeMessageId: second.messageId,
			correlation: { sequence: (accepted?.sequence ?? 0) - 1, clientMessageId: "c3", clientTurnId: "t1" },
			refusedCorrelations: 1,
		});
		// And: the identity member says one correlation was refused and its family is partial
		const { texts } = await produced(rig.lane, root);
		expect(JSON.parse(texts.get("identity/identity") ?? "")).toMatchObject({
			activeMessageId: second.messageId,
			turnId: turn?.turnId,
			refusedCorrelations: 1,
		});
		const registry = readFamilyRegistry(texts.get("families/families") ?? "");
		expect(registry.assembly === "incomplete" ? registry.incomplete : []).toEqual(["identity"]);
		rig.lane.release(stale);
		rig.lane.release(root);
	} finally {
		await rig.close();
	}
});
