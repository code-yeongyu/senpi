import type { ConformanceManifest } from "./mapping.ts";
import type { AdapterKind } from "./registry.ts";

/** A host under test: its name in reports, the adapter kinds it provides, and the adapters handed to each case. */
export interface ConformanceHost<TAdapters> {
	readonly name: string;
	readonly provides: readonly AdapterKind[];
	readonly adapters: TAdapters;
}

/** A case passes when it resolves and fails when it rejects. */
export type CaseImplementation<TAdapters> = (adapters: TAdapters) => Promise<void>;

export type CaseResult =
	| { readonly id: string; readonly status: "pass" }
	| { readonly id: string; readonly status: "fail"; readonly error: string };

/** One host's run of the manifest. There is no skip: a case that cannot run on the host fails. */
export interface HostReport {
	readonly host: string;
	readonly suite_hash: string;
	readonly results: readonly CaseResult[];
}

async function runCase<TAdapters>(
	id: string,
	adapters: readonly AdapterKind[],
	host: ConformanceHost<TAdapters>,
	implementation: CaseImplementation<TAdapters> | undefined,
): Promise<CaseResult> {
	if (implementation === undefined)
		return { id, status: "fail", error: "no implementation is registered for this case" };
	const missing = adapters.filter((kind) => !host.provides.includes(kind));
	if (missing.length > 0)
		return { id, status: "fail", error: `the host does not provide adapter: ${missing.join(", ")}` };
	try {
		await implementation(host.adapters);
		return { id, status: "pass" };
	} catch (error) {
		return { id, status: "fail", error: error instanceof Error ? error.message : String(error) };
	}
}

/** Run every manifest case on `host`, one at a time in manifest order, and report under the manifest's suite hash. */
export async function runSuite<TAdapters>(
	manifest: ConformanceManifest,
	host: ConformanceHost<TAdapters>,
	implementations: ReadonlyMap<string, CaseImplementation<TAdapters>>,
): Promise<HostReport> {
	const results: CaseResult[] = [];
	for (const entry of manifest.cases) {
		results.push(await runCase(entry.id, entry.adapters, host, implementations.get(entry.id)));
	}
	return { host: host.name, suite_hash: manifest.suite_hash, results };
}
