import { afterEach, expect, it, vi } from "vitest";
import { readRequiredKinds } from "../../../src/modes/rpc/compact-recovery-manifest-kinds.ts";
import { recoveryRig } from "./4272-recovery-support.ts";
import { manifestCut, refuseOneCorrelation, sortedFamilies } from "./5397-manifest-required-kinds-support.ts";

// Fixes #5397 (RULING-128 open rule): a client opens the manifest's requiredKinds only when it equals the complete-family
// list of the digest-verified families/families component; the digest covers the component, not the manifest field.

afterEach(() => {
	vi.restoreAllMocks();
});

const wire = (manifest: object, requiredKinds?: unknown): Record<string, unknown> => {
	const decoded = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
	if (requiredKinds === undefined) return decoded;
	return { ...decoded, requiredKinds };
};

it("RULING-128 an intact manifest opens exactly its requiredKinds, for a full and a partial cut", async () => {
	for (const partial of [false, true]) {
		// Given: a cut, its manifest as the page decodes it and its registry read through the digest-verified route
		const rig = recoveryRig();
		if (partial) refuseOneCorrelation(rig);
		const cut = await manifestCut(rig);
		// Then: the reader answers the manifest's own list
		expect(readRequiredKinds(wire(cut.manifest), cut.registry)).toEqual({
			ok: true,
			requiredKinds: cut.manifest.requiredKinds,
		});
		await cut.release();
	}
});

it("RULING-128 an altered requiredKinds with an intact registry component and checkpointDigest is refused manifest_required_kinds_mismatch", async () => {
	// Given: a cut whose identity family is partial, its registry component verified against checkpointDigest
	const rig = recoveryRig();
	refuseOneCorrelation(rig);
	const cut = await manifestCut(rig);
	expect(cut.root.digest).toBe(cut.manifest.checkpointDigest);
	const listed = cut.manifest.requiredKinds;
	// When: only the manifest's list is altered (the partial family claimed, one dropped, the order reversed)
	for (const altered of [
		sortedFamilies([...listed, "identity"]),
		listed.slice(1),
		[...listed].reverse(),
		[...listed, listed[0]],
	]) {
		const tampered = wire(cut.manifest, altered);
		expect(tampered.checkpointDigest).toBe(cut.manifest.checkpointDigest);
		// Then: the reader refuses it typed, never opening the altered list
		expect(readRequiredKinds(tampered, cut.registry), JSON.stringify(altered)).toEqual({
			ok: false,
			code: "manifest_required_kinds_mismatch",
		});
	}
	await cut.release();
});

it("RULING-128 (3)(4) a manifest without the list or naming an unknown kind is refused typed, never opened from a built-in list", async () => {
	const rig = recoveryRig();
	const cut = await manifestCut(rig);
	const { requiredKinds: _dropped, ...older } = wire(cut.manifest);
	expect(readRequiredKinds(older, cut.registry)).toEqual({ ok: false, code: "manifest_missing_required_kinds" });
	expect(readRequiredKinds(wire(cut.manifest, "active"), cut.registry)).toEqual({
		ok: false,
		code: "manifest_missing_required_kinds",
	});
	const unknown = [...cut.manifest.requiredKinds, "zz-future-family"];
	expect(readRequiredKinds(wire(cut.manifest, unknown), cut.registry)).toEqual({
		ok: false,
		code: "manifest_unknown_required_kind",
	});
	await cut.release();
});
