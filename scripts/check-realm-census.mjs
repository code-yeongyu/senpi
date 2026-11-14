#!/usr/bin/env node
// Realm census (design #12965, 3.3): every workspace package whose code runs in the engine realm is a root, and every
// module-scope binding or static class field in a root that can hold state must be classified in
// scripts/realm-census.json. A new binding, a removed one, a changed root set, or an AsyncLocalStorage kept per copy
// without a recorded ground fails, so completeness is enforced rather than assumed.
//
// Roots: realm-census-roots.mjs. Population: realm-census-population.mjs (rule: realm-census-initializers.mjs).
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectPopulation } from "./realm-census-population.mjs";
import { deriveRoots } from "./realm-census-roots.mjs";
import { toPosix } from "./realm-census-source.mjs";

const CLASSES = ["constant", "per-copy-safe", "realm-registry", "realm-global-functional"];

/** Compare the tree against the census table. Returns the derived roots, the population and every problem found. */
function runCensus({ root, table, dropRoots = [] }) {
	const problems = [];
	const derived = deriveRoots(root, { dropRoots });
	const tableRoots = [...(table.roots ?? [])].sort();
	const missingFromTable = derived.filter((dir) => !tableRoots.includes(dir));
	const missingFromDerivation = tableRoots.filter((dir) => !derived.includes(dir));
	if (missingFromTable.length > 0 || missingFromDerivation.length > 0) {
		problems.push(
			`derived roots differ from the table roots: derived only [${missingFromTable.join(", ")}], table only [${missingFromDerivation.join(", ")}]`,
		);
	}

	const population = collectPopulation(root, derived);
	const entries = table.bindings ?? {};
	const keys = new Set(population.map((binding) => binding.key));
	for (const binding of population) {
		const entry = entries[binding.key];
		if (!entry) {
			problems.push(`unclassified binding ${binding.key} (${binding.kind}, line ${binding.line})`);
			continue;
		}
		if (!CLASSES.includes(entry.class)) problems.push(`entry ${binding.key} has unknown class "${entry.class}"`);
		if (typeof entry.reason !== "string" || entry.reason.trim() === "")
			problems.push(`entry ${binding.key} has no reason`);
		if (entry.ground !== undefined && entry.ground !== "i" && entry.ground !== "ii") {
			problems.push(`entry ${binding.key} has unknown ground "${entry.ground}"`);
		}
		// Structural class rule (omo#12965 re-read, F4a): a reason cannot turn a registry into a per-copy table or the
		// reverse. A binding initialised by `realmRegistry(` is class realm-registry; a realm-registry entry lives in a
		// file that creates a registry.
		if (binding.registry && entry.class !== "realm-registry") {
			problems.push(`entry ${binding.key} is initialised by realmRegistry() but classified ${entry.class}`);
		}
		if (entry.class === "realm-registry" && !binding.fileCreatesRegistry) {
			problems.push(`entry ${binding.key} is classified realm-registry but its file creates no realm registry`);
		}
		if (binding.als && entry.class !== "realm-registry") {
			if (entry.ground !== "i" && entry.ground !== "ii") {
				problems.push(
					`AsyncLocalStorage ${binding.key} is classified ${entry.class} without "ground": "i" or "ii"`,
				);
			} else if (entry.ground === "ii" && !/\bsplit\b/iu.test(entry.reason ?? "")) {
				problems.push(
					`AsyncLocalStorage ${binding.key} uses ground ii but its reason does not state what a split costs`,
				);
			}
		}
	}
	for (const key of Object.keys(entries).sort()) {
		if (!keys.has(key)) problems.push(`stale entry ${key} (no such binding in the roots)`);
	}

	const byClass = {};
	for (const binding of population) {
		const name = entries[binding.key]?.class ?? "unclassified";
		byClass[name] = (byClass[name] ?? 0) + 1;
	}
	return { roots: { derived, table: tableRoots }, population, byClass, problems };
}

function parseArgs(argv) {
	const options = { root: undefined, table: undefined, json: false, dropRoots: [] };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--json") options.json = true;
		else if (arg === "--root") options.root = argv[++index];
		else if (arg === "--table") options.table = argv[++index];
		// Test-only (mutant M12): remove a package from the derivation.
		else if (arg === "--test-drop-root") options.dropRoots.push(argv[++index]);
		else throw new Error(`unknown argument ${arg}`);
	}
	return options;
}

function main() {
	const options = parseArgs(process.argv.slice(2));
	const root = resolve(options.root ?? join(fileURLToPath(new URL(".", import.meta.url)), ".."));
	const tablePath = resolve(options.table ?? join(root, "scripts", "realm-census.json"));
	const table = JSON.parse(readFileSync(tablePath, "utf8"));
	const result = runCensus({ root, table, dropRoots: options.dropRoots });
	if (options.json) {
		process.stdout.write(`${JSON.stringify(result, null, "\t")}\n`);
	} else if (result.problems.length > 0) {
		process.stderr.write(
			`realm census: ${result.problems.length} problem(s) against ${toPosix(relative(root, tablePath))}\n`,
		);
		for (const problem of result.problems) process.stderr.write(`  - ${problem}\n`);
	} else {
		const classes = Object.entries(result.byClass)
			.map(([name, count]) => `${name} ${count}`)
			.join(", ");
		process.stdout.write(
			`realm census: ${result.population.length} bindings in ${result.roots.derived.length} roots classified (${classes})\n`,
		);
	}
	process.exitCode = result.problems.length > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
