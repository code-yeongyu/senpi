/**
 * NeoRuntimeOptions extraction test.
 *
 * The neo daemon reconstructs each connection's runtime from a typed
 * NeoRuntimeOptions handshake payload. Every classic CLI flag the
 * runtime-construction path consumes must be represented in that payload, or a
 * neo client silently loses that flag when it goes through the shared daemon.
 *
 * Rather than hand-maintaining the field list, this test GENERATES it from the
 * source: it statically scans main.ts for `parsed.<field>` reads and asserts
 * every one is either
 *   (a) covered by NEO_RUNTIME_OPTION_SOURCE_FIELDS (threaded into the payload), or
 *   (b) an explicitly documented carve-out (NEO_RUNTIME_OPTION_CARVEOUT_FIELDS).
 *
 * A future consumer that reads a new `parsed.*` field in main.ts fails this test
 * until it is either threaded through NeoRuntimeOptions or documented as a
 * carve-out — which is exactly the drift protection the plan requires.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	NEO_RUNTIME_OPTION_CARVEOUT_FIELDS,
	NEO_RUNTIME_OPTION_SOURCE_FIELDS,
} from "../src/modes/rpc/neo-runtime-options.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_TS = join(__dirname, "..", "src", "main.ts");

/** Extract the set of distinct `parsed.<field>` field names read in main.ts. */
function extractParsedFieldReads(source: string): Set<string> {
	const fields = new Set<string>();
	const re = /\bparsed\.([a-zA-Z_$][a-zA-Z0-9_$]*)/g;
	let match: RegExpExecArray | null = re.exec(source);
	while (match !== null) {
		fields.add(match[1]);
		match = re.exec(source);
	}
	return fields;
}

describe("NeoRuntimeOptions field extraction", () => {
	const source = readFileSync(MAIN_TS, "utf8");
	const parsedFields = extractParsedFieldReads(source);
	const sourceFields = new Set<string>(NEO_RUNTIME_OPTION_SOURCE_FIELDS);
	const carveoutFields = new Set(Object.keys(NEO_RUNTIME_OPTION_CARVEOUT_FIELDS));

	it("finds a non-trivial set of parsed.* reads (sanity)", () => {
		// Guards against a regex or path regression that would make the test vacuous.
		expect(parsedFields.size).toBeGreaterThan(20);
		expect(parsedFields.has("model")).toBe(true);
		expect(parsedFields.has("apiKey")).toBe(true);
	});

	it("covers every runtime-consumed parsed.* field (threaded or carved out)", () => {
		const uncovered = [...parsedFields].filter((f) => !sourceFields.has(f) && !carveoutFields.has(f));
		expect(
			uncovered,
			`New parsed.* consumer(s) not threaded into NeoRuntimeOptions and not documented as a carve-out: ${uncovered.join(
				", ",
			)}. Add each to NEO_RUNTIME_OPTION_SOURCE_FIELDS (and the NeoRuntimeOptions type) or NEO_RUNTIME_OPTION_CARVEOUT_FIELDS with a reason.`,
		).toEqual([]);
	});

	it("does not declare source fields that main.ts never reads (no dead payload fields)", () => {
		const dead = [...sourceFields].filter((f) => !parsedFields.has(f));
		expect(
			dead,
			`NeoRuntimeOptions declares source field(s) that main.ts no longer reads: ${dead.join(
				", ",
			)}. Remove them from NEO_RUNTIME_OPTION_SOURCE_FIELDS.`,
		).toEqual([]);
	});

	it("does not declare carve-outs that main.ts never reads (no stale carve-outs)", () => {
		// Some carve-outs are consumed only in the neo launcher/daemon modules
		// (not main.ts), so they legitimately never appear in main.ts's parsed.*
		// reads. Exclude those known launcher-local flags from the stale check.
		const launcherLocalCarveouts = new Set(["neoIsolated", "neoBin", "neoRegister"]);
		const staleCarveouts = [...carveoutFields].filter((f) => !parsedFields.has(f) && !launcherLocalCarveouts.has(f));
		expect(staleCarveouts, `Carve-out field(s) no longer read in main.ts: ${staleCarveouts.join(", ")}.`).toEqual([]);
	});

	it("keeps source fields and carve-outs disjoint", () => {
		const overlap = [...sourceFields].filter((f) => carveoutFields.has(f));
		expect(overlap, `Fields declared as BOTH runtime source and carve-out: ${overlap.join(", ")}`).toEqual([]);
	});
});
