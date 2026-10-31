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

// Part of #4272 (S10a fold, RULING-61 Q2 = A, Q3 = A): the `source` family is `partial` until S10b locates its
// producer; the registry every consumer receives is a discriminated union on `assembly`, so an incomplete assembly
// cannot be used as a complete one without the check, in the type and at run time.

afterEach(() => {
	vi.restoreAllMocks();
});

/** A consumer that enumerates members: it can only be given a registry the check narrowed. */
const enumerated = (registry: CompleteFamilyRegistry): number => registry.families.length;

it("RULING-61 Q2 custom kinds stay in `source`, whose producer is partial until S10b; identity stays pending", () => {
	expect(FAMILY_PRODUCERS.source).toBe("partial");
	expect(FAMILY_PRODUCERS.identity).toBe("pending");
	expect(FAMILY_PRODUCERS.transcript).toBe("complete");
	expect(FAMILY_PRODUCERS.opaque).toBe("complete");
});

it("RULING-61 Q3 the registry a consumer reads is incomplete by type and value, and is not accepted as complete", async () => {
	// Given: a fresh epoch's catalog
	const rig = recoveryRig();
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
	expect(registry.assembly === "incomplete" ? registry.incomplete : []).toEqual([
		"active",
		"calls",
		"settled",
		"identity",
		"source",
	]);
	expect(completeAssembly(registry)).toBeUndefined();
	expect(registry.families).toEqual(
		CATALOG_FAMILIES.map((family) => ({ family, producer: FAMILY_PRODUCERS[family] })),
	);
	catalog.release();
	await rig.lane.idle();
});

it("RULING-61 Q3 only a registry whose every producer is complete narrows to a complete assembly", () => {
	const all = Object.fromEntries(CATALOG_FAMILIES.map((family) => [family, "complete" as const]));
	const complete = familyRegistry({ ...FAMILY_PRODUCERS, ...all });
	expect(complete.assembly).toBe("complete");
	const narrowed = completeAssembly(complete);
	expect(narrowed && enumerated(narrowed)).toBe(CATALOG_FAMILIES.length);
	expect(completeAssembly(familyRegistry({ ...FAMILY_PRODUCERS, ...all, opaque: "partial" }))).toBeUndefined();
	expect(() => readFamilyRegistry(JSON.stringify({ ...complete, assembly: "complete", families: [] }))).toThrow(
		/registry/,
	);
});

it("RULING-61 Q3 the compiler refuses an un-narrowed registry and a hand-written complete one where a complete assembly is required", () => {
	const registry: FamilyRegistry = familyRegistry(FAMILY_PRODUCERS);
	const forged = {
		format: "senpi-recovery-families",
		version: 1,
		families: registry.families,
		assembly: "complete",
	} as const;
	// @ts-expect-error TS2345: an un-narrowed registry may be incomplete; only completeAssembly narrows it
	const unchecked = enumerated(registry);
	// @ts-expect-error TS2345: a literal lacks the brand only the registry module's constructors set
	const handWritten = enumerated(forged);
	expect([unchecked, handWritten], "the run time cannot tell; the types refuse both").toEqual([
		CATALOG_FAMILIES.length,
		CATALOG_FAMILIES.length,
	]);
	expect(completeAssembly(registry)).toBeUndefined();
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
