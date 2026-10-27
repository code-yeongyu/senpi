import { expect, it } from "vitest";
import {
	BOUNDED_ID_MAX_BYTES,
	catalogRootRef,
	childRef,
	parseBoundedId,
	parseContentDigest,
	parseContentRef,
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
