import { afterEach, expect, it, vi } from "vitest";
import { storedBytes } from "../../../src/modes/rpc/compact-catalog-codec.ts";
import {
	CATALOG_FAMILIES,
	FAMILY_PRODUCERS,
	familyRegistry,
	readFamilyRegistry,
} from "../../../src/modes/rpc/compact-catalog-registry.ts";
import { specDigest } from "./4272-frozen-bytes-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";
import { manifestCut, refuseOneCorrelation, sortedFamilies } from "./5397-manifest-required-kinds-support.ts";

// Fixes #5397 (RULING-128): the manifest states the catalog families its root requires, the cut's complete families
// only, sorted and de-duplicated, and the list is part of the content checkpointDigest covers.

afterEach(() => {
	vi.restoreAllMocks();
});

it("RULING-128 (1)(5) a full cut requires every catalog family, sorted and de-duplicated", async () => {
	// Given: a fresh epoch whose every producer is complete
	const rig = recoveryRig();
	// When: its manifest is built
	const cut = await manifestCut(rig);
	// Then: the list is every family, in code-unit order, once each, and equals the registry's complete families
	expect(cut.registry.assembly).toBe("complete");
	expect(cut.manifest.requiredKinds).toEqual(sortedFamilies(CATALOG_FAMILIES));
	expect(new Set(cut.manifest.requiredKinds).size).toBe(cut.manifest.requiredKinds.length);
	expect(cut.manifest.requiredKinds).toEqual(sortedFamilies(cut.complete));
	await cut.release();
});

it("RULING-128 (1)(5) a cut with one partial family (a refused correlation) leaves only that family out", async () => {
	// Given: a correlated record refused at the protocol depth limit, so identity is partial (RULING-67 (4))
	const rig = recoveryRig();
	refuseOneCorrelation(rig);
	// When: the cut's manifest is built
	const cut = await manifestCut(rig);
	// Then: the engine excluded the one partial family and kept the rest in order
	expect(cut.registry.assembly === "incomplete" ? cut.registry.incomplete : []).toEqual(["identity"]);
	expect(cut.manifest.requiredKinds).toEqual(sortedFamilies(CATALOG_FAMILIES.filter((f) => f !== "identity")));
	expect(cut.manifest.requiredKinds).toEqual(sortedFamilies(cut.complete));
	await cut.release();
});

it("RULING-128 (1) an unavailable transcript leaves the three entry-fed families out", async () => {
	// Given: an epoch whose transcript became unavailable (RULING-61 Q1)
	const rig = recoveryRig();
	rig.lane.applyTranscript([{ kind: "unavailable", reason: "transcript_tail_trimmed" }]);
	// When: the cut's manifest is built
	const cut = await manifestCut(rig);
	// Then: transcript, opaque and source are not required; every complete family is
	const partial = new Set(["transcript", "opaque", "source"]);
	expect(cut.manifest.requiredKinds).toEqual(sortedFamilies(CATALOG_FAMILIES.filter((f) => !partial.has(f))));
	expect(cut.manifest.requiredKinds).toEqual(sortedFamilies(cut.complete));
	await cut.release();
});

it("RULING-128 (1) the list is in the digested registry component, so it cannot change without the checkpoint digest", async () => {
	// Given: a full cut, its root node (digest = checkpointDigest) and its registry component read through it
	const rig = recoveryRig();
	const cut = await manifestCut(rig);
	expect(cut.root.digest).toBe(cut.manifest.checkpointDigest);
	// Then: the component's stored bytes carry the manifest's exact list, and its root entry digests those bytes
	expect((JSON.parse(cut.familiesText) as { requiredKinds?: unknown }).requiredKinds).toEqual(
		cut.manifest.requiredKinds,
	);
	expect(cut.entry.digest).toBe(specDigest("leaf", storedBytes(cut.familiesText)));
	// And: any other list is other bytes (the root entry, hence checkpointDigest, no longer matches) and the one
	// decoder refuses it, whether a kind is dropped, added twice or out of order
	const parsed = JSON.parse(cut.familiesText) as Record<string, unknown>;
	const list = cut.manifest.requiredKinds;
	for (const tampered of [list.slice(1), [...list, list[0]], [...list].reverse()]) {
		const text = JSON.stringify({ ...parsed, requiredKinds: tampered });
		expect(specDigest("leaf", storedBytes(text))).not.toBe(cut.entry.digest);
		expect(() => readFamilyRegistry(text), JSON.stringify(tampered)).toThrow(RangeError);
	}
	await cut.release();
});

it("RULING-128 (1) the registry derives the list from its producers: partial families are never required", () => {
	for (const partial of [[], ["identity"], ["transcript", "opaque", "source"], [...CATALOG_FAMILIES]] as const) {
		const producers = { ...FAMILY_PRODUCERS, ...Object.fromEntries(partial.map((f) => [f, "partial"])) };
		const registry = familyRegistry(producers);
		const expected = sortedFamilies(CATALOG_FAMILIES.filter((f) => !(partial as readonly string[]).includes(f)));
		expect(registry.requiredKinds, partial.join(",")).toEqual(expected);
		expect(readFamilyRegistry(JSON.stringify(registry)).requiredKinds).toEqual(expected);
	}
});
