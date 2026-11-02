/**
 * Engine build identity: the ordinal a client compares instead of a version STRING.
 *
 * The daemon decides "is that host older than me?" from this ordinal alone, so the
 * ordering it defines is the whole contract: CalVer `-N` is a POST-release increment
 * here (`2026.9.16-3` ships AFTER `2026.9.16`), which is the exact opposite of what
 * semver says about the same two strings. The suite pins both sides of that
 * disagreement so nobody "fixes" the parser by reaching for semver.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { describe, expect, it } from "vitest";
import { VERSION } from "../../src/config.ts";
import {
	compareEngineOrdinal,
	type EngineBuildIdentity,
	engineBuildIdentity,
	engineBuildIdentityFrom,
} from "../../src/core/engine-build-identity.ts";

const EPOCH = 1_758_000_000;

function identity(version: string, epoch?: number): EngineBuildIdentity {
	return engineBuildIdentityFrom(epoch === undefined ? { version } : { version, epoch, sha7: "abc1234" });
}

describe("engineBuildIdentityFrom", () => {
	it("parses a CalVer version into [y, m, d, n] with n = 0 when the -N suffix is absent", () => {
		const table: ReadonlyArray<readonly [string, readonly number[]]> = [
			["2026.9.16", [2026, 9, 16, 0]],
			["2026.9.16-3", [2026, 9, 16, 3]],
			["2026.9.16-10", [2026, 9, 16, 10]],
			["2026.9.17", [2026, 9, 17, 0]],
			["2026.10.1", [2026, 10, 1, 0]],
		];

		for (const [version, expected] of table) {
			expect([version, [...identity(version).ordinal.slice(0, 4)]]).toEqual([version, [...expected]]);
		}
	});

	it("reports scheme nodef with a zero epoch when no build epoch was defined, and never throws on a non-CalVer version", () => {
		expect(identity("2026.9.16")).toEqual({ text: "2026.9.16", ordinal: [2026, 9, 16, 0, 0], scheme: "nodef" });
		expect(identity("not-a-version")).toEqual({ text: "not-a-version", ordinal: [0, 0, 0, 0, 0], scheme: "nodef" });
		expect(identity("0.0.0")).toEqual({ text: "0.0.0", ordinal: [0, 0, 0, 0, 0], scheme: "nodef" });
	});

	it("appends the build epoch and short sha to the text when the build defined them", () => {
		expect(engineBuildIdentityFrom({ version: "2026.9.16-3", epoch: EPOCH, sha7: "abc1234" })).toEqual({
			text: "2026.9.16-3+1758000000.abc1234",
			ordinal: [2026, 9, 16, 3, EPOCH],
			scheme: "epoch",
		});
	});
});

describe("compareEngineOrdinal", () => {
	it("orders CalVer post-release increments ascending: 2026.9.16 < 2026.9.16-2 < 2026.9.16-3 < 2026.9.16-10 < 2026.9.17", () => {
		const ascending = ["2026.9.16", "2026.9.16-2", "2026.9.16-3", "2026.9.16-10", "2026.9.17"];

		const pairs = ascending.slice(0, -1).map((version, index) => {
			const next = ascending[index + 1];
			return [`${version} vs ${next}`, compareEngineOrdinal(identity(version), identity(next))];
		});

		expect(pairs).toEqual(
			ascending.slice(0, -1).map((version, index) => [`${version} vs ${ascending[index + 1]}`, -1]),
		);
		expect(compareEngineOrdinal(identity("2026.9.17"), identity("2026.9.16-10"))).toBe(1);
		expect(compareEngineOrdinal(identity("2026.9.16-3"), identity("2026.9.16-3"))).toBe(0);
	});

	it("DISAGREES with semver, which ranks the bare version above its -N post-release", () => {
		// semver reads `-3` as a PRERELEASE: 2026.9.16 wins. The engine reads it as the
		// third build cut after 2026.9.16, so 2026.9.16-3 wins. A compatibility decision
		// made with semver would hand off backwards.
		expect(semver.compare("2026.9.16", "2026.9.16-3")).toBe(1);
		expect(compareEngineOrdinal(identity("2026.9.16"), identity("2026.9.16-3"))).toBe(-1);
	});

	it("never imports semver from the production module", () => {
		const source = readFileSync(
			join(import.meta.dirname, "..", "..", "src", "core", "engine-build-identity.ts"),
			"utf8",
		);

		expect(source).not.toMatch(/from\s+["']semver["']/);
	});

	it("calls equal versions EQUAL when either side lacks a build epoch, so an uncomparable build never wins", () => {
		const nodef = identity("2026.9.16-3");
		const older = engineBuildIdentityFrom({ version: "2026.9.16-3", epoch: EPOCH, sha7: "abc1234" });
		const newer = engineBuildIdentityFrom({ version: "2026.9.16-3", epoch: EPOCH + 60, sha7: "def5678" });

		expect(compareEngineOrdinal(newer, nodef)).toBe(0);
		expect(compareEngineOrdinal(nodef, newer)).toBe(0);
		expect(compareEngineOrdinal(nodef, identity("2026.9.16-3"))).toBe(0);
		// Both sides carry an epoch: the epoch decides, and only then.
		expect(compareEngineOrdinal(newer, older)).toBe(1);
		expect(compareEngineOrdinal(older, newer)).toBe(-1);
	});

	it("lets the version decide before the epoch, so a newer version with an older epoch still wins", () => {
		const newerVersionOlderEpoch = engineBuildIdentityFrom({ version: "2026.9.17", epoch: EPOCH, sha7: "abc1234" });
		const olderVersionNewerEpoch = engineBuildIdentityFrom({
			version: "2026.9.16-3",
			epoch: EPOCH + 86_400,
			sha7: "def5678",
		});

		expect(compareEngineOrdinal(newerVersionOlderEpoch, olderVersionNewerEpoch)).toBe(1);
	});
});

describe("engineBuildIdentity", () => {
	it("reports this tree's package version, and scheme nodef when the build defined no epoch", () => {
		const built = engineBuildIdentity();

		expect(built.text.startsWith(VERSION)).toBe(true);
		expect([...built.ordinal.slice(0, 4)]).toEqual([
			...engineBuildIdentityFrom({ version: VERSION }).ordinal.slice(0, 4),
		]);
		// Running from source there is no --define, so the identity must degrade to nodef
		// rather than inventing an epoch (and must never throw reading an undefined global).
		expect(built.scheme).toBe("nodef");
		expect(built.text).toBe(VERSION);
	});

	it("returns the same identity on every call", () => {
		expect(engineBuildIdentity()).toEqual(engineBuildIdentity());
	});
});
