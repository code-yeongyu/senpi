// Assemble one SC-LIVE run record from what the run left behind: the RPC events and transcript (session-driver), the
// hook trace, the recording proxy's first tool-bearing provider request (O3 tool declarations, O4 sanitized headers,
// normalized with the EQ normalizer so run-scoped roots compare equal), and the fixture checker's verdict on the work dir.
import { existsSync, readFileSync } from "node:fs";
import { childRuntime, readJsonl, repoRoot } from "../../../../scripts/lib/common.mjs";
import { createNormalizer } from "../../../../scripts/lib/equivalence-normalize.mjs";
import { checkTask, LICENSE_ANSWER } from "../check.mjs";

const lines = (path) => (existsSync(path) ? readJsonl(readFileSync(path, "utf8")) : []);

/** The O3/O4 observation of a run: its first provider request's declarations and sanitized headers, normalized. */
export const firstToolRequest = (proxy) => proxy.records.find((record) => Array.isArray(record.tools));

export function firstRequestObservations(setup, proxy, extraRoots = []) {
	const first = firstToolRequest(proxy);
	const normalize = createNormalizer({
		roots: [
			{ prefix: setup.box.dir, token: "<sandbox>" },
			{ prefix: repoRoot(), token: "<repo>" },
			{ prefix: proxy.origin, token: "<proxy>" },
			...extraRoots,
		],
	});
	return { O3: normalize(first?.tools ?? null), O4: normalize(first?.headers ?? null) };
}

/**
 * @param {{ setup: object, session: object, proxy: object, placement: string, answer?: string, extraRoots?: object[],
 *   otherPlacements?: object[], reference?: object }} options
 */
export function buildRunRecord({
	setup,
	session,
	proxy,
	placement,
	answer = LICENSE_ANSWER,
	extraRoots,
	otherPlacements = [],
	reference,
}) {
	return {
		placement,
		events: session.events,
		entries: session.entries,
		entriesAfterReopen: session.entriesAfterReopen,
		hookTrace: lines(setup.hookTrace),
		turns: session.turns,
		meter: session.meter,
		questions: session.questions,
		reopen: session.reopen,
		observations: firstRequestObservations(setup, proxy, extraRoots),
		childRuntime: childRuntime().label,
		otherPlacements,
		reference,
		checker: checkTask(setup.box.cwd, { license: answer }),
	};
}
