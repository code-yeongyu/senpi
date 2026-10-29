import type { RegisteredCase } from "./registry.ts";
import { computeSuiteHash, sha256Hex } from "./suite-hash.ts";

export type MappingProblemCode =
	| "duplicate-id"
	| "malformed-id"
	| "malformed-impl"
	| "missing-intro"
	| "missing-adapters"
	| "duplicate-adapter"
	| "missing-expected";

export interface MappingProblem {
	readonly id: string;
	readonly code: MappingProblemCode;
}

export interface ManifestCase extends RegisteredCase {
	readonly impl_hash: string;
}

/** The exported suite: what every host runs and every host report is compared against. */
export interface ConformanceManifest {
	readonly suite_hash: string;
	readonly cases: readonly ManifestCase[];
}

const CASE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const isRepoRelativeTs = (path: string): boolean =>
	path.endsWith(".ts") && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");

function problemsOf(entry: RegisteredCase): MappingProblemCode[] {
	const codes: MappingProblemCode[] = [];
	if (!CASE_ID.test(entry.id)) codes.push("malformed-id");
	if (!isRepoRelativeTs(entry.impl)) codes.push("malformed-impl");
	if (entry.intro.trim() === "") codes.push("missing-intro");
	if (entry.adapters.length === 0) codes.push("missing-adapters");
	if (new Set(entry.adapters).size !== entry.adapters.length) codes.push("duplicate-adapter");
	if (entry.expected.trim() === "") codes.push("missing-expected");
	return codes;
}

/** Every reason the registry is not a complete, unambiguous mapping; empty when it is. */
export function findMappingProblems(cases: readonly RegisteredCase[]): MappingProblem[] {
	const problems: MappingProblem[] = [];
	const seen = new Set<string>();
	for (const entry of cases) {
		if (seen.has(entry.id)) problems.push({ id: entry.id, code: "duplicate-id" });
		seen.add(entry.id);
		for (const code of problemsOf(entry)) problems.push({ id: entry.id, code });
	}
	return problems;
}

/** Registered cases with no implementation, and implementations with no registered case. */
export function findImplementationGaps(
	cases: readonly Pick<RegisteredCase, "id">[],
	implementations: ReadonlyMap<string, unknown>,
): { unimplemented: string[]; unregistered: string[] } {
	const registered = new Set(cases.map((entry) => entry.id));
	return {
		unimplemented: [...registered].filter((id) => !implementations.has(id)),
		unregistered: [...implementations.keys()].filter((id) => !registered.has(id)),
	};
}

/** Build the manifest export, hashing each implementation file through `readImpl` (repository-relative path). */
export async function buildManifest(
	cases: readonly RegisteredCase[],
	readImpl: (impl: string) => Promise<Uint8Array>,
): Promise<ConformanceManifest> {
	const problems = findMappingProblems(cases);
	if (problems.length > 0) {
		throw new Error(`conformance registry mapping problems: ${problems.map((p) => `${p.id} ${p.code}`).join(", ")}`);
	}
	const manifestCases: ManifestCase[] = [];
	for (const entry of cases) {
		let bytes: Uint8Array;
		try {
			bytes = await readImpl(entry.impl);
		} catch (error) {
			throw new Error(`conformance case ${entry.id}: cannot read its implementation ${entry.impl}`, {
				cause: error,
			});
		}
		manifestCases.push({ ...entry, impl_hash: await sha256Hex(bytes) });
	}
	return { suite_hash: await computeSuiteHash(manifestCases), cases: manifestCases };
}
