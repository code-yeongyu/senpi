import {
	decideWithPathFacts,
	type PathFacts,
	withPathFacts,
} from "../../src/core/extensions/builtin/permission-system/path-facts.ts";

/**
 * Run a synchronous permission parse or decision the way the host does (senpi#4565): its path probes read facts
 * fetched off the host thread, and it is run again until none is missing.
 */
export function withFetchedFacts<T>(run: (facts: PathFacts) => T): Promise<T> {
	return decideWithPathFacts((facts) => withPathFacts(facts, () => run(facts)));
}
