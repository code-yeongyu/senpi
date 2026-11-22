import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { CATALOG_FAMILIES } from "../../../src/modes/rpc/compact-catalog-registry.ts";
import { committedGoldens, serialize } from "./4272-recovery-golden-files.ts";
import { recoveryRig } from "./4272-recovery-support.ts";
import { manifestCut, refuseOneCorrelation, sortedFamilies } from "./5397-manifest-required-kinds-support.ts";

// Fixes #5397 (RULING-128 (5)): the shared golden of a manifest whose cut has one partial family, produced by the real
// manifest path and never edited by hand; the desktop opens exactly `requiredKinds`, read verbatim.
// The normalizer aliases every digest, so a golden cannot show that checkpointDigest covers requiredKinds; the unit test
// "the list is in the digested registry component" in 5397-manifest-required-kinds.test.ts proves it.

const DIRECTORY = "docs/engine-socket/fixtures/recovery-manifest";
const REGENERATE =
	"SENPI_WRITE_RECOVERY_GOLDENS=1 npx vitest run test/suite/regressions/5397-required-kinds-golden.test.ts (packages/coding-agent, senpi repository)";
const CASE = {
	caseId: "one-partial-family",
	kind: "manifest",
	contractIds: ["R4.B1", "RULING-61", "RULING-67", "RULING-128"],
	description:
		"A cut whose identity family is partial (one client correlation refused at the protocol depth limit): requiredKinds lists the nine complete families in code-unit order and leaves identity out; the cut's families/families registry carries the same list.",
} as const;

/** A run's random epoch ids and the digests they reach become stable aliases; every other byte is the engine's. */
function stable(text: string): string {
	const ids = new Map<string, string>();
	const digests = new Map<string, string>();
	return text
		.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, (id) => {
			if (!ids.has(id)) ids.set(id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
			return ids.get(id) ?? id;
		})
		.replace(/\b[0-9a-f]{64}\b/g, (digest) => {
			if (!digests.has(digest))
				digests.set(digest, createHash("sha256").update(`fixture-${digests.size}`).digest("hex"));
			return digests.get(digest) ?? digest;
		});
}

async function produce(): Promise<Map<string, string>> {
	const rig = recoveryRig();
	refuseOneCorrelation(rig);
	const cut = await manifestCut(rig);
	const expected = JSON.parse(stable(JSON.stringify({ manifest: cut.manifest, families: cut.registry }))) as unknown;
	await cut.release();
	const index = {
		contract: "CONTRACT-r6",
		section: "B1",
		rulings: ["RULING-60", "RULING-61", "RULING-67", "RULING-128"],
		requiredKindsRule:
			"manifest.requiredKinds is the sorted (code-unit order), de-duplicated list of the catalog families this cut's root requires: its complete families only, partial ones excluded by the engine. The same list is the requiredKinds of the cut's families/families registry component, inside the content checkpointDigest covers.",
		clientRules: [
			"Read requiredKinds verbatim; never derive it from a built-in family list.",
			"A manifest without requiredKinds (an older engine) is refused as manifest_missing_required_kinds, never opened from a built-in list.",
			"A kind the client does not know is refused as manifest_unknown_required_kind, never ignored.",
			"A list that differs from the complete families of the digest-verified families/families component is refused as manifest_required_kinds_mismatch.",
		],
		normalization:
			"Random epoch ids become 00000000-0000-4000-8000-<n> and every 64-hex digest a stable alias, in order of first appearance; every other byte is the engine's.",
		regenerate: REGENERATE,
		cases: [{ caseId: CASE.caseId, file: `${CASE.caseId}.json`, kind: CASE.kind, contractIds: CASE.contractIds }],
	};
	return new Map([
		["index.json", serialize(index)],
		[`${CASE.caseId}.json`, serialize({ ...CASE, expected })],
	]);
}

it("RULING-128 (5) the committed one-partial-family manifest golden is the engine's output, identity excluded", async () => {
	const generated = await produce();
	expect(committedGoldens(DIRECTORY, generated)).toEqual(generated);
	const golden = JSON.parse(generated.get(`${CASE.caseId}.json`) ?? "") as {
		expected: { manifest: { requiredKinds: string[] }; families: { requiredKinds: string[]; incomplete: string[] } };
	};
	expect(golden.expected.manifest.requiredKinds).toEqual(
		sortedFamilies(CATALOG_FAMILIES.filter((family) => family !== "identity")),
	);
	expect(golden.expected.families.incomplete).toEqual(["identity"]);
	expect(golden.expected.families.requiredKinds).toEqual(golden.expected.manifest.requiredKinds);
});
