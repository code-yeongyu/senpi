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
 *
 * The ordinal is ALWAYS written in senpi CalVer (senpi#7040). A distribution that compiles this
 * engine beside its own package.json (the compiled omo binary reads `{ name: "omo", version:
 * "5.1.78" }` as `VERSION`) defines `SENPI_ENGINE_VERSION` with the embedded engine's CalVer; without
 * it such a build advertised `[5, 1, 78, 0, 0]`. An ordinal that is not CalVer names no position in
 * the release order, so `compareEngineOrdinal` never orders it and `engineSuccessionRefusal` refuses it.
 */
import { VERSION } from "../config.ts";

/** Compile-time defines; absent outside a `--define`d build, hence the `typeof` guards below. */
declare const SENPI_BUILD_EPOCH: number | undefined;
declare const SENPI_BUILD_SHA7: string | undefined;
/** The embedded senpi's own CalVer, defined by a distribution whose package.json carries its brand version. */
declare const SENPI_ENGINE_VERSION: string | undefined;

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
	version: typeof SENPI_ENGINE_VERSION === "string" && SENPI_ENGINE_VERSION !== "" ? SENPI_ENGINE_VERSION : VERSION,
	epoch: typeof SENPI_BUILD_EPOCH === "number" ? SENPI_BUILD_EPOCH : 0,
	sha7: typeof SENPI_BUILD_SHA7 === "string" ? SENPI_BUILD_SHA7 : "",
});

/** Identity of the running engine build. Constant for the life of the process. */
export function engineBuildIdentity(): EngineBuildIdentity {
	return BUILT;
}

/** No senpi release predates 2000, so a CalVer ordinal's first part is a year at or after it. */
const FIRST_CALVER_YEAR = 2000;

/** Whether both ordinals are senpi CalVer, the only vocabulary two builds are ordered in (senpi#7040). */
export function comparableEngines(a: EngineBuildIdentity, b: EngineBuildIdentity): boolean {
	return a.ordinal[0] >= FIRST_CALVER_YEAR && b.ordinal[0] >= FIRST_CALVER_YEAR;
}

/**
 * Orders two builds: `-1` when `a` is older, `1` when newer, `0` when they are equal
 * OR uncomparable. `[y, m, d, n]` is compared lexicographically; the build epoch breaks
 * a tie ONLY when BOTH sides carry one, so a build of unknown age can never outrank a
 * known one - the caller's handoff rule is "strictly greater", and 0 attaches instead.
 * A pair with an ordinal outside senpi CalVer (an omo version, an unparseable version) is
 * uncomparable: `[2026, 11, 18]` is not newer than an omo `[5, 1, 78]` that runs a later engine.
 */
export function compareEngineOrdinal(a: EngineBuildIdentity, b: EngineBuildIdentity): -1 | 0 | 1 {
	if (!comparableEngines(a, b)) return 0;
	for (let index = 0; index < 4; index++) {
		if (a.ordinal[index] !== b.ordinal[index]) return a.ordinal[index] > b.ordinal[index] ? 1 : -1;
	}
	if (a.scheme !== "epoch" || b.scheme !== "epoch" || a.ordinal[4] === b.ordinal[4]) return 0;
	return a.ordinal[4] > b.ordinal[4] ? 1 : -1;
}

/** The identity a running host advertises (`engineVersion`, `engineOrdinal`): a non-zero epoch is an `epoch` build. */
export function engineIdentityOf(text: string, ordinal: EngineOrdinal): EngineBuildIdentity {
	return { text, ordinal, scheme: ordinal[4] > 0 ? "epoch" : "nodef" };
}

/** Why a running host is not handed over to a successor engine; both ends of a handoff answer with `reason`. */
export interface EngineSuccessionRefusal {
	readonly reason: "older_engine" | "unordered_engine";
	readonly detail: string;
}

/**
 * Why handing `running` over to `successor` is refused, or `undefined` when it is not. `older_engine` (senpi#7018):
 * the successor is strictly older by `compareEngineOrdinal`; equal builds, and builds uncomparable only for a missing
 * build epoch, are not older. `unordered_engine` (senpi#7040, senpi#7044): a pair outside senpi CalVer cannot be
 * proven not older, so the running host keeps its engine. An explicit downgrade is the only way past either.
 */
export function engineSuccessionRefusal(
	successor: EngineBuildIdentity,
	running: EngineBuildIdentity,
): EngineSuccessionRefusal | undefined {
	if (!comparableEngines(successor, running)) {
		return {
			reason: "unordered_engine",
			detail: `the successor's engine ${successor.text} [${successor.ordinal.join(",")}] cannot be ordered against the running host's ${running.text} [${running.ordinal.join(",")}]: only two senpi CalVer engine ordinals are comparable`,
		};
	}
	if (compareEngineOrdinal(successor, running) >= 0) return undefined;
	return {
		reason: "older_engine",
		detail: `the successor's engine ${successor.text} is older than the running host's ${running.text}`,
	};
}
