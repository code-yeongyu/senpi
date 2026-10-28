/**
 * The engine-trust marker is a versioned wire contract: omo's launcher, senpi's spawners and the
 * desktop all write it, and a launch decides adopt / import / refuse from it (omo#10762, design r13
 * 5.2 and 5.4). These tests guard that contract: what parses as version 1, and what never does.
 */
import { describe, expect, it } from "vitest";
import {
	ENGINE_TRUST_FALLBACK_REASONS,
	EngineTrustContractError,
	type EngineTrustMarker,
	parseEngineTrustMarker,
	serializeEngineTrustMarker,
} from "../../src/engine-trust/index.ts";
import { serverMarker, standaloneMarker } from "./engine-trust-fixtures.ts";

function variant(patch: Record<string, unknown>): string {
	return JSON.stringify({ ...serverMarker, ...patch });
}

describe("engine trust marker version 1", () => {
	it("round-trips every field through one line of JSON", () => {
		const text = serializeEngineTrustMarker(serverMarker);
		expect(text).not.toContain("\n");
		expect(parseEngineTrustMarker(text)).toEqual(serverMarker);
		const optIn: EngineTrustMarker = { ...standaloneMarker, defaults: null };
		expect(parseEngineTrustMarker(serializeEngineTrustMarker(optIn))).toEqual(optIn);
	});

	it("names exactly the ten fallback codes of design 6.2", () => {
		expect([...ENGINE_TRUST_FALLBACK_REASONS].sort()).toEqual(
			[
				"access-denied",
				"helper-crash",
				"helper-malformed-output",
				"helper-missing",
				"helper-signature",
				"helper-timeout",
				"helper-wrong-arch",
				"linux-bundle-malformed",
				"linux-bundle-unreadable",
				"negatives-incomplete",
			].sort(),
		);
	});

	// A text that is not exactly version 1 makes the marker foreign: it costs one import, never trust.
	const notVersionOne: ReadonlyArray<readonly [string, string]> = [
		["not JSON", "{"],
		["a JSON array", "[]"],
		["version 2", variant({ v: 2 })],
		["a missing field", JSON.stringify({ ...serverMarker, user: undefined })],
		["an unknown field", variant({ exec: 1 })],
		["an empty file", variant({ file: "" })],
		["a file holding NUL", variant({ file: "/x\u0000y.pem" })],
		["an upper-case digest", variant({ sha256: "A".repeat(64) })],
		["a short digest", variant({ sha256: "a".repeat(63) })],
		["an os import with a reason", variant({ fallbackReason: "helper-timeout" })],
		["a fallback without a reason", variant({ automatic: "fallback" })],
		["an unknown fallback reason", variant({ automatic: "fallback", fallbackReason: "flag" })],
		["an unknown owner", variant({ owner: "desktop" })],
		["a server launch without the closure", variant({ defaults: null })],
		["a closure without a directory", variant({ defaults: { file: "/e.pem" } })],
		["a malformed user digest", variant({ user: "zz" })],
		["a restore of an unknown name", variant({ restore: { PATH: "/bin" } })],
		["a restore holding a number", variant({ restore: { SSL_CERT_DIR: 1 } })],
		[
			"a standalone restore of BUN_OPTIONS",
			variant({ owner: "standalone", defaults: null, restore: { BUN_OPTIONS: "x" } }),
		],
	];

	it.each(notVersionOne)("does not parse %s", (_name, text) => {
		expect(parseEngineTrustMarker(text)).toBeUndefined();
	});

	it("refuses to write a marker that would not parse", () => {
		const bad = { ...serverMarker, defaults: null };
		expect(() => serializeEngineTrustMarker(bad)).toThrow(EngineTrustContractError);
	});
});
