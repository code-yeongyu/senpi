import { expect, it } from "vitest";
import {
	BOUNDED_ID_MAX_BYTES,
	baseRef,
	CATALOG_NODE_MAX_ENTRIES,
	CATALOG_REF_MAX_STEPS,
	catalogRootRef,
	childRef,
	parseBoundedId,
	parseContentDigest,
	parseContentRef,
	parsePageRef,
	refSteps,
} from "../../../src/modes/rpc/compact-recovery-ids.ts";

// Part of #4272 (S09, RULING-57 Q2): one allow-list identifier grammar, checked before any use. S15's admission
// identifiers reuse this exact module (conformance test recorded on #4272).

it.each([
	["a path separator", "attach/1"],
	["a backslash", "attach\\1"],
	["a dot-dot segment", ".."],
	["a dot-dot inside", "a/../b"],
	["an embedded NUL", "attach-1\0"],
	["a leading dot", ".attach"],
	["a space", "attach 1"],
	["a non-ASCII character", "attach-\u00e9"],
	["a quote", 'attach"1'],
])("RULING-57 Q2 (1) a bounded id refuses %s as forbidden_character", (_label, value) => {
	expect(parseBoundedId(value)).toEqual({ ok: false, reason: "forbidden_character" });
});

it("RULING-57 Q2 (1) a bounded id refuses the empty string and an overlong id, and accepts exactly 128 ASCII bytes", () => {
	expect(parseBoundedId("")).toEqual({ ok: false, reason: "empty" });
	expect(parseBoundedId("a".repeat(BOUNDED_ID_MAX_BYTES + 1))).toEqual({ ok: false, reason: "overlong" });
	expect(parseBoundedId("a".repeat(BOUNDED_ID_MAX_BYTES))).toEqual({ ok: true, value: "a".repeat(128) });
	// The byte bound is checked before the character class: 64 two-byte characters are 128 bytes, still refused.
	expect(parseBoundedId("\u00e9".repeat(65))).toEqual({ ok: false, reason: "overlong" });
	expect(parseBoundedId("socket-1:3")).toEqual({ ok: true, value: "socket-1:3" });
	expect(parseBoundedId("attach-1")).toEqual({ ok: true, value: "attach-1" });
});

it("RULING-57 Q2 a SHA-256 digest is exactly 64 lowercase hex characters", () => {
	const lower = "ab".repeat(32);
	expect(parseContentDigest(lower)).toEqual({ ok: true, value: lower });
	expect(parseContentDigest("AB".repeat(32))).toEqual({ ok: false, reason: "malformed" });
	expect(parseContentDigest("ab".repeat(31))).toEqual({ ok: false, reason: "malformed" });
	expect(parseContentDigest(`${"ab".repeat(32)}a`)).toEqual({ ok: false, reason: "malformed" });
	expect(parseContentDigest("")).toEqual({ ok: false, reason: "empty" });
});

it("RULING-57 Q2 a content ref is a fixed-size counter root with three-digit child steps, never a storage number or a path", () => {
	const root = catalogRootRef(7);
	expect(root).toBe("c-0000000000000007");
	expect(childRef(childRef(root, 0), 127)).toBe("c-0000000000000007:000:127");
	expect(refSteps(childRef(childRef(root, 5), 12))).toEqual([5, 12]);
	expect(refSteps(root)).toEqual([]);
	expect(() => childRef(root, 128)).toThrow(RangeError);
	expect(() => childRef(root, -1)).toThrow(RangeError);
	expect(() => catalogRootRef(10 ** 16)).toThrow(RangeError);
	expect(parseContentRef("c-0000000000000007:000")).toEqual({ ok: true, value: "c-0000000000000007:000" });
	for (const bad of ["7", "c-7", "c-0000000000000007:1", "C-0000000000000007", "leaf-42"])
		expect(parseContentRef(bad), bad).toEqual({ ok: false, reason: "malformed" });
	// The id allow-list runs first, so a separator is refused as a character before the ref grammar is consulted.
	expect(parseContentRef("c-0000000000000007/000")).toEqual({ ok: false, reason: "forbidden_character" });
	expect(parseContentRef(`c-0000000000000007${":000".repeat(28)}`)).toEqual({ ok: false, reason: "overlong" });
	// A ref is itself a bounded id: the same character class and bound, so it can be logged or keyed as one.
	expect(parseBoundedId(childRef(root, 3))).toEqual({ ok: true, value: "c-0000000000000007:003" });
});

it("RULING-58 (3) a ref has at most CATALOG_REF_MAX_STEPS child steps: the validator refuses a deeper one as too_deep and the minter never produces one", () => {
	expect(CATALOG_REF_MAX_STEPS).toBe(8);
	const deepest = `c-0000000000000007${":000".repeat(CATALOG_REF_MAX_STEPS)}`;
	expect(Buffer.byteLength(deepest)).toBeLessThan(BOUNDED_ID_MAX_BYTES);
	expect(parseContentRef(deepest)).toEqual({ ok: true, value: deepest });
	expect(parseContentRef(`${deepest}:000`)).toEqual({ ok: false, reason: "too_deep" });
	expect(parseContentRef(`${deepest}${":127".repeat(5)}`)).toEqual({ ok: false, reason: "too_deep" });
	let ref = catalogRootRef(7);
	for (let step = 0; step < CATALOG_REF_MAX_STEPS; step++) ref = childRef(ref, 0);
	expect(ref).toBe(deepest);
	expect(refSteps(ref)).toHaveLength(CATALOG_REF_MAX_STEPS);
	expect(() => childRef(ref, 0)).toThrow(RangeError);
});

it("RULING-71 (1) `<catalogRoot>:base` passes the one validator like every ref and is reserved: the component grammar refuses it by name, so no component ref is ever minted with it", () => {
	const root = catalogRootRef(7);
	const base = baseRef(root);
	expect(base).toBe("c-0000000000000007:base");
	// It is a bounded id under the same allow-list and byte bound as every ref, and the page route parses it as the base
	expect(parseBoundedId(base)).toEqual({ ok: true, value: base });
	expect(parsePageRef(base)).toEqual({ ok: true, value: { kind: "base", ref: base } });
	// The component grammar refuses the reserved step by name at any position, so a parsed component ref never carries it
	for (const reserved of [base, `${root}:000:base`, `${root}:base:000`])
		expect(parseContentRef(reserved), reserved).toEqual({ ok: false, reason: "reserved" });
	expect(parsePageRef(`${root}:000:base`)).toEqual({ ok: false, reason: "reserved" });
	// The minter goes through that grammar: every child step under a root and under a child is a component, never the base
	for (const parent of [root, childRef(root, 0)])
		for (let index = 0; index < CATALOG_NODE_MAX_ENTRIES; index++) {
			const ref = childRef(parent, index);
			expect(parsePageRef(ref)).toEqual({ ok: true, value: { kind: "catalog", ref } });
		}
	expect(() => baseRef(childRef(root, 0))).toThrow(RangeError);
});
