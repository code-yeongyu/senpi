/**
 * Build identity of THIS engine, as an ORDINAL rather than a version string.
 *
 * Two hosts of the same protocol decide which of them is newer by comparing
 * `ordinal`, never by comparing `serverVersion` strings: this product's CalVer
 * `-N` suffix is a POST-release increment (`2026.9.16-3` ships AFTER
 * `2026.9.16`), which is the exact opposite of the semver reading of the same
 * two strings. Nothing here imports semver, and nothing may.
 *
 * `epoch` is the committer timestamp of the built commit, injected at compile
 * time (`bun build --define SENPI_BUILD_EPOCH=… --define SENPI_BUILD_SHA7=…`,
 * see `scripts/build-binaries.sh`). A build without git metadata - and every
 * run from source - simply has no define: the identity degrades to scheme
 * `nodef` with a zero epoch instead of failing, and an uncomparable pair is
 * then EQUAL, so a build whose age cannot be established never wins a
 * generation handoff.
 */
import { VERSION } from "../config.ts";

/** Compile-time defines; absent outside a `--define`d build, hence the `typeof` guards below. */
declare const SENPI_BUILD_EPOCH: number | undefined;
declare const SENPI_BUILD_SHA7: string | undefined;

/** `epoch`: the epoch was defined at build time and may break a version tie. `nodef`: it was not. */
export type EngineOrdinalScheme = "epoch" | "nodef";

/** `[year, month, day, postReleaseIncrement, buildEpochSeconds]`. */
export type EngineOrdinal = readonly [number, number, number, number, number];

export interface EngineBuildIdentity {
	/** Human- and log-facing build string: `VERSION` plus `+<epoch>.<sha7>` when defined. */
	readonly text: string;
	readonly ordinal: EngineOrdinal;
	readonly scheme: EngineOrdinalScheme;
}

export interface EngineBuildInput {
	/** CalVer package version: `2026.9.16` or `2026.9.16-3`. */
	readonly version: string;
	/** Committer epoch of the built commit, in seconds. Absent or 0 selects scheme `nodef`. */
	readonly epoch?: number;
	/** Short commit sha of the built commit, for the text only. */
	readonly sha7?: string;
}

const CALVER = /^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?/;

/** Builds an identity from explicit inputs. Never throws: an unparseable version is ordinal zero. */
export function engineBuildIdentityFrom(build: EngineBuildInput): EngineBuildIdentity {
	const match = CALVER.exec(build.version);
	const epoch = Number.isSafeInteger(build.epoch) && build.epoch !== undefined && build.epoch > 0 ? build.epoch : 0;
	const sha7 = build.sha7 ?? "";
	return {
		text: epoch === 0 ? build.version : `${build.version}+${epoch}${sha7 === "" ? "" : `.${sha7}`}`,
		ordinal: [
			match ? Number(match[1]) : 0,
			match ? Number(match[2]) : 0,
			match ? Number(match[3]) : 0,
			match?.[4] ? Number(match[4]) : 0,
			epoch,
		],
		scheme: epoch === 0 ? "nodef" : "epoch",
	};
}

const BUILT: EngineBuildIdentity = engineBuildIdentityFrom({
	version: VERSION,
	epoch: typeof SENPI_BUILD_EPOCH === "number" ? SENPI_BUILD_EPOCH : 0,
	sha7: typeof SENPI_BUILD_SHA7 === "string" ? SENPI_BUILD_SHA7 : "",
});

/** Identity of the running engine build. Constant for the life of the process. */
export function engineBuildIdentity(): EngineBuildIdentity {
	return BUILT;
}

/**
 * Orders two builds: `-1` when `a` is older, `1` when newer, `0` when they are equal
 * OR uncomparable. `[y, m, d, n]` is compared lexicographically; the build epoch breaks
 * a tie ONLY when BOTH sides carry one, so a build of unknown age can never outrank a
 * known one - the caller's handoff rule is "strictly greater", and 0 attaches instead.
 */
export function compareEngineOrdinal(a: EngineBuildIdentity, b: EngineBuildIdentity): -1 | 0 | 1 {
	for (let index = 0; index < 4; index++) {
		if (a.ordinal[index] !== b.ordinal[index]) return a.ordinal[index] > b.ordinal[index] ? 1 : -1;
	}
	if (a.scheme !== "epoch" || b.scheme !== "epoch" || a.ordinal[4] === b.ordinal[4]) return 0;
	return a.ordinal[4] > b.ordinal[4] ? 1 : -1;
}
