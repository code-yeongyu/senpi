import { describe, expect, it } from "vitest";
import { rootModeIsGuarded } from "../src/modes/rpc/host-socket-bind.ts";

const SELF = 501;
const OTHER = 502;

// senpi#5404 review LOW 1: the owner of a sticky directory can still rename or delete any entry in it, so a sticky
// root only guards our alias when this user or root owns it.
describe("rootModeIsGuarded", () => {
	it.each([
		["root-owned sticky /tmp", { mode: 0o41777, uid: 0 }, true],
		["our own sticky directory", { mode: 0o41777, uid: SELF }, true],
		["another user's sticky 1777 directory", { mode: 0o41777, uid: OTHER }, false],
		["our private 0700 directory", { mode: 0o40700, uid: SELF }, true],
		["root's private 0755 directory", { mode: 0o40755, uid: 0 }, true],
		["our group-writable 0770 directory", { mode: 0o40770, uid: SELF }, false],
		["another user's private 0700 directory", { mode: 0o40700, uid: OTHER }, false],
	])("%s -> %s", (_label, entry, expected) => {
		expect(rootModeIsGuarded(entry, SELF)).toBe(expected);
	});

	it("never trusts an owner it cannot compare (no getuid, Windows)", () => {
		expect(rootModeIsGuarded({ mode: 0o41777, uid: OTHER }, undefined)).toBe(false);
		expect(rootModeIsGuarded({ mode: 0o41777, uid: 0 }, undefined)).toBe(true);
	});
});
