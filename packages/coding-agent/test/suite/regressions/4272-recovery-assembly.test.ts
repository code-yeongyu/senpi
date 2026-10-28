import { afterEach, expect, it, vi } from "vitest";
import {
	CATALOG_FAMILIES,
	type CompleteFamilyRegistry,
	completeAssembly,
	FAMILY_PRODUCERS,
	type FamilyRegistry,
	familyRegistry,
	readFamilyRegistry,
} from "../../../src/modes/rpc/compact-catalog-registry.ts";
import { catalogOf } from "./4272-catalog-read-support.ts";
import { recoveryRig } from "./4272-recovery-support.ts";

// Part of #4272 (S10a fold, RULING-61 Q2 = A, Q3 = A; S10b): every family has a complete producer, a root whose
// transcript is a loaded base or unavailable stays partial; the registry every consumer receives is a discriminated
// union on `assembly`, so an incomplete assembly cannot be used as a complete one without the check, in the type and
// at run time.

afterEach(() => {
	vi.restoreAllMocks();
});

/** A consumer that enumerates members: it can only be given a registry the check narrowed. */
const enumerated = (registry: CompleteFamilyRegistry): number => registry.families.length;

it("RULING-61 Q2 custom kinds stay in `source`, whose producer is complete since S10b; identity is complete too", () => {
	expect(FAMILY_PRODUCERS.source).toBe("complete");
	expect(FAMILY_PRODUCERS.identity).toBe("complete");
	expect(FAMILY_PRODUCERS.transcript).toBe("complete");
	expect(FAMILY_PRODUCERS.opaque).toBe("complete");
});

it("RULING-61 Q3 the registry a consumer reads at a partial root is incomplete by type and value, and is not accepted as complete", async () => {
	// Given: an epoch whose transcript became unavailable, so the entry-fed families are partial
	const rig = recoveryRig();
	rig.lane.applyTranscript([{ kind: "unavailable", reason: "transcript_tail_trimmed" }]);
	const catalog = await catalogOf(rig);
	// When: the registry component is parsed through the one reader every consumer uses
	const registry: FamilyRegistry = readFamilyRegistry((await catalog.text("families", "families")).text);
	// Then: the assembly is incomplete, names every family that is not complete, and the complete narrowing refuses it
	expect(registry.assembly).toBe("incomplete");
	const narrowed = completeAssembly(registry);
	expect(
		narrowed && enumerated(narrowed),
		"an incomplete assembly never reaches the enumerating consumer",
	).toBeUndefined();
	expect(registry.assembly === "incomplete" ? registry.incomplete : []).toEqual(["transcript", "opaque", "source"]);
	expect(completeAssembly(registry)).toBeUndefined();
	expect(registry.families).toEqual(
		CATALOG_FAMILIES.map((family) => ({
			family,
			producer: ["transcript", "opaque", "source"].includes(family) ? "partial" : "complete",
		})),
	);
	catalog.release();
	await rig.lane.idle();
});

it("RULING-61 Q3 only a registry whose every producer is complete narrows to a complete assembly", () => {
	const complete = familyRegistry(FAMILY_PRODUCERS);
	expect(complete.assembly).toBe("complete");
	const narrowed = completeAssembly(complete);
	expect(narrowed && enumerated(narrowed)).toBe(CATALOG_FAMILIES.length);
	expect(completeAssembly(familyRegistry({ ...FAMILY_PRODUCERS, opaque: "partial" }))).toBeUndefined();
	expect(() => readFamilyRegistry(JSON.stringify({ ...complete, assembly: "complete", families: [] }))).toThrow(
		/registry/,
	);
});

it("RULING-61 Q1 an unavailable transcript leaves opaque uncounted: partial, never an explicit empty", async () => {
	// Given: an epoch whose transcript became unavailable
	const rig = recoveryRig();
	rig.lane.applyTranscript([{ kind: "unavailable", reason: "transcript_tail_trimmed" }]);
	// When: the cut is cataloged
	const catalog = await catalogOf(rig);
	// Then: no opaque component is emitted and both transcript producers report partial
	expect(catalog.entries.filter(([kind]) => kind === "opaque")).toEqual([]);
	expect(readFamilyRegistry((await catalog.text("families", "families")).text)).toMatchObject({
		assembly: "incomplete",
		families: expect.arrayContaining([
			{ family: "transcript", producer: "partial" },
			{ family: "opaque", producer: "partial" },
		]),
	});
	catalog.release();
	await rig.lane.idle();
});
