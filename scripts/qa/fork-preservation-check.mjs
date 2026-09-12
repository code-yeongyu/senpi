#!/usr/bin/env node
// Fork-preservation oracle for upstream syncs: every invariant an upstream merge
// has silently dropped before is asserted here from source, so the check runs on
// an unbuilt tree. Prints exactly one JSON line {pass, failures[]}; exits 0 only
// when pass is true.
//
// usage: node scripts/qa/fork-preservation-check.mjs [--root <dir>]
//          [--omo-loader-aliases <bundle-purity.test.ts copy>]
//          [--expect-upstream-sha <sha>] [--anthropic-sdk <version>]
//          [--compare-exports <baseline-dist-index.js> <candidate-dist-index.js>]
//
// Hard-coded fork facts, read out of OURS (4f4cd7451, 2026-09-12) rather than
// trusted from the plan text:
//   - theme validator symbol: `validateThemeJson` in
//     packages/coding-agent/src/modes/interactive/theme/theme.ts:110. It exists at
//     the merge base and at OURS but is gone at upstream THEIRS (71dca871b), so it
//     is exactly the symbol an upstream-favouring resolution deletes.
//   - grok themes live in .../modes/interactive/theme/grok-{day,night}.json
//     (`git ls-files | grep -i grok`), not in a themes/ subdirectory.
//   - CACHE_FRIENDLY_CONTEXT_SAFETY_TOKENS is a module const in
//     packages/coding-agent/src/core/compaction/compaction.ts:895, not an
//     @earendil-works/pi-ai export; it is checked where it actually lives.
//   - the loader alias list (VIRTUAL_MODULES + getAliases) is a superset of omo's
//     SENPI_LOADER_ALIASES: senpi also aliases `*/pi-ai/providers/all`, which omo
//     does not list. omo's 19 entries must all survive, extras are fine.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	declaresExport,
	dependencyVersions,
	modelCatalogRows,
	objectLiteralKeys,
	packageManifests,
	quotedStringsInStatement,
	readIfExists,
	sourceExportsSymbol,
	stringArrayLiteral,
} from "./fork-preservation-checks.mjs";

const CA = "packages/coding-agent";
const THEME_DIR = `${CA}/src/modes/interactive/theme`;
const HELD_PINS = { openai: "6.26.0", vitest: "4.1.11", "signal-exit": "3.0.7" };
const ASTRA_ID = ["gpt", "6", "astra"].join("-");
const ASTRA_CONTEXT_WINDOW = 600000;
const ASTRA_MIN_ROWS = 13;
const CALVER = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d+)?$/;

function parseArgs(argv) {
	const args = { root: process.cwd(), anthropicSdk: "0.123.0" };
	for (let index = 0; index < argv.length; index += 1) {
		const flag = argv[index];
		if (flag === "--root") args.root = argv[(index += 1)];
		else if (flag === "--omo-loader-aliases") args.omoLoaderAliases = argv[(index += 1)];
		else if (flag === "--expect-upstream-sha") args.expectUpstreamSha = argv[(index += 1)];
		else if (flag === "--anthropic-sdk") args.anthropicSdk = argv[(index += 1)];
		else if (flag === "--compare-exports") args.compareExports = [argv[(index += 1)], argv[(index += 1)]];
		else throw new Error(`unknown argument: ${flag}`);
	}
	if (args.root === undefined) throw new Error("--root requires a directory");
	return args;
}

/** One failure string per dropped invariant; the symbol is always named. */
function runSourceChecks(root, args, fail) {
	const read = (relative) => readIfExists(join(root, relative));
	const has = (relative) => existsSync(join(root, relative));
	const exportsSymbol = (relative, name) => sourceExportsSymbol(join(root, relative), name);
	// Fail-closed and keep going: one unreadable manifest must not hide the rest.
	const readJson = (relative) => {
		const raw = read(relative);
		if (raw === null) return fail(`${relative}: missing`);
		try {
			return JSON.parse(raw);
		} catch (error) {
			return fail(`${relative}: invalid JSON (${error.message})`);
		}
	};

	// 1. ai barrel + the cache-friendly compaction headroom constant.
	if (!exportsSymbol("packages/ai/src/index.ts", "estimateContextTokens")) {
		fail("packages/ai/src/index.ts: missing export estimateContextTokens");
	}
	const compaction = read(`${CA}/src/core/compaction/compaction.ts`);
	if (compaction === null || !compaction.includes("CACHE_FRIENDLY_CONTEXT_SAFETY_TOKENS")) {
		fail(`${CA}/src/core/compaction/compaction.ts: missing CACHE_FRIENDLY_CONTEXT_SAFETY_TOKENS`);
	}

	// 2. agent barrel (buildProviderContext is re-exported via agent-loop.ts).
	for (const name of ["ProviderRetryWatchdogAbortError", "buildProviderContext"]) {
		if (!exportsSymbol("packages/agent/src/index.ts", name))
			fail(`packages/agent/src/index.ts: missing export ${name}`);
	}

	// 3. type-only export - invisible to runtime Object.keys, so source-checked.
	const codingAgentIndex = read(`${CA}/src/index.ts`);
	if (codingAgentIndex === null || !declaresExport(codingAgentIndex, "CacheFriendlySummaryOptions")) {
		fail(`${CA}/src/index.ts: missing type export CacheFriendlySummaryOptions`);
	}

	// 4. gist-backed /share stays in interactive mode; no upstream session-share.ts.
	const interactive = read(`${CA}/src/modes/interactive/interactive-mode.ts`);
	if (interactive === null || !interactive.includes('"/share"') || !interactive.includes('"gist"')) {
		fail(`${CA}/src/modes/interactive/interactive-mode.ts: missing gist "/share" path`);
	}
	if (has(`${CA}/src/modes/interactive/session-share.ts`)) {
		fail(`${CA}/src/modes/interactive/session-share.ts: upstream session share reintroduced`);
	}

	// 5. theme validator + grok themes.
	const theme = read(`${THEME_DIR}/theme.ts`);
	const themeJson = read(`${THEME_DIR}/theme-json.ts`);
	// The fork validator is the TypeBox-compiled ThemeJsonSchema. It may live in theme.ts (pre-sync layout,
	// `const validateThemeJson = Compile(ThemeJsonSchema)`) or in theme-json.ts with theme.ts re-exporting it
	// (post-sync lazy-load layout). Either way theme.ts must expose validateThemeJson and the compiled schema must exist.
	const exposesValidator =
		theme !== null &&
		(/\bconst\s+validateThemeJson\s*=/.test(theme) ||
			/export\s*\{[^}]*\bvalidateThemeJson\b[^}]*\}\s*from\s*["']\.\/theme-json\.ts["']/.test(theme));
	const compiledSchema = [theme, themeJson].some((src) => src !== null && /Compile\(ThemeJsonSchema\)/.test(src));
	if (!exposesValidator || !compiledSchema) {
		fail(`${THEME_DIR}/theme.ts: missing theme validator validateThemeJson`);
	}
	for (const name of ["grok-day.json", "grok-night.json"]) {
		if (!has(`${THEME_DIR}/${name}`)) fail(`${THEME_DIR}/${name}: missing grok theme`);
	}

	// 6. synchronous process-tree kill helpers.
	const shell = read(`${CA}/src/utils/shell.ts`);
	for (const name of ["killWindowsProcessTree", "killProcessTree"]) {
		if (shell === null || !declaresExport(shell, name)) fail(`${CA}/src/utils/shell.ts: missing export ${name}`);
		else if (new RegExp(`export\\s+async\\s+function\\s+${name}\\b`).test(shell)) {
			fail(`${CA}/src/utils/shell.ts: ${name} must stay synchronous`);
		}
	}

	// 7. write tool keeps the fork's structured details.
	const write = read(`${CA}/src/core/tools/write.ts`);
	if (write === null || !write.includes("details: createWriteDetails(")) {
		fail(`${CA}/src/core/tools/write.ts: missing details: createWriteDetails(`);
	}

	// 8. fork-owned model shard survives catalog regeneration.
	if (!has("packages/ai/src/providers/devin.models.ts")) {
		fail("packages/ai/src/providers/devin.models.ts: missing fork-owned model shard");
	}
	const shards = read("packages/ai/scripts/model-shards.ts");
	const owned = shards === null ? null : quotedStringsInStatement(shards, "FORK_OWNED_MODEL_SHARDS");
	if (owned === null || !owned.includes("devin.models.ts")) {
		fail("packages/ai/scripts/model-shards.ts: FORK_OWNED_MODEL_SHARDS missing devin.models.ts");
	}

	// 9. held dependency pins across the root and workspace manifests.
	const pins = { ...HELD_PINS, "@anthropic-ai/sdk": args.anthropicSdk };
	for (const relative of packageManifests(root)) {
		const manifest = readJson(relative);
		if (!manifest) continue;
		for (const [name, expected] of Object.entries(pins)) {
			for (const { field, version } of dependencyVersions(manifest, name)) {
				if (version !== expected) fail(`${relative}: ${field}.${name} is ${version}, held pin is ${expected}`);
			}
		}
	}

	// 10/11. published package identity.
	if (has(`${CA}/npm-shrinkwrap.json`)) fail(`${CA}/npm-shrinkwrap.json: must stay absent`);
	const pkg = readJson(`${CA}/package.json`);
	if (pkg) {
		if (pkg.name !== "@code-yeongyu/senpi") fail(`${CA}/package.json: name is ${pkg.name}`);
		if (pkg.bin?.senpi !== "dist/cli.js") fail(`${CA}/package.json: bin.senpi is ${pkg.bin?.senpi}`);
		if (!CALVER.test(pkg.version ?? "")) fail(`${CA}/package.json: version ${pkg.version} is not CalVer`);
		for (const entry of [".", "./rpc-entry", "./client"]) {
			if (pkg.exports?.[entry] === undefined) fail(`${CA}/package.json: exports["${entry}"] missing`);
		}
	}

	// 12. omo's SENPI_LOADER_ALIASES must all stay resolvable by the loader.
	if (args.omoLoaderAliases !== undefined) {
		const omoSource = readIfExists(args.omoLoaderAliases);
		const omoAliases = omoSource === null ? null : stringArrayLiteral(omoSource, "SENPI_LOADER_ALIASES");
		const loaderSource = read(`${CA}/src/core/extensions/loader.ts`);
		const virtual = loaderSource === null ? null : objectLiteralKeys(loaderSource, "const VIRTUAL_MODULES");
		const jiti = loaderSource === null ? null : objectLiteralKeys(loaderSource, "_aliases = {");
		if (omoAliases === null || omoAliases.length === 0) {
			fail(`${args.omoLoaderAliases}: SENPI_LOADER_ALIASES array literal not found`);
		} else if (virtual === null || jiti === null) {
			fail(`${CA}/src/core/extensions/loader.ts: alias maps VIRTUAL_MODULES/_aliases not found`);
		} else {
			for (const [label, keys] of [
				["VIRTUAL_MODULES", virtual],
				["_aliases", jiti],
			]) {
				const missing = omoAliases.filter((alias) => !keys.includes(alias)).sort();
				if (missing.length > 0) {
					fail(`${CA}/src/core/extensions/loader.ts: ${label} missing omo aliases ${missing.join(", ")}`);
				}
			}
		}
	}

	// 13. upstream pin.
	if (args.expectUpstreamSha !== undefined) {
		const sha = readJson(".github/upstream.json")?.sha;
		if (sha !== args.expectUpstreamSha)
			fail(`.github/upstream.json: sha is ${sha}, expected ${args.expectUpstreamSha}`);
	}

	// 14. Astra context-window overlay (id assembled, never written literally).
	const dataDir = join(root, "packages/ai/src/providers/data");
	let astra = [];
	try {
		astra = modelCatalogRows(dataDir).filter((row) => row.id.includes(ASTRA_ID));
	} catch (error) {
		fail(`packages/ai/src/providers/data: unreadable model catalog (${error.message})`);
		return;
	}
	if (astra.length < ASTRA_MIN_ROWS) {
		fail(`packages/ai/src/providers/data: ${astra.length} astra rows, expected at least ${ASTRA_MIN_ROWS}`);
	}
	for (const row of astra.filter((row) => row.contextWindow !== ASTRA_CONTEXT_WINDOW)) {
		fail(
			`packages/ai/src/providers/data/${row.file}: ${row.provider}/${row.id} contextWindow is ${row.contextWindow}, expected ${ASTRA_CONTEXT_WINDOW}`,
		);
	}
}

/** Runtime barrel diff: candidate export names must be a superset of baseline. */
async function compareExports([baselinePath, candidatePath], fail) {
	if (baselinePath === undefined || candidatePath === undefined) {
		throw new Error("--compare-exports requires <baseline-dist-index.js> <candidate-dist-index.js>");
	}
	const names = async (path) => {
		const module = await import(pathToFileURL(path).href);
		return Object.keys(module).sort();
	};
	const baseline = await names(baselinePath);
	const candidate = new Set(await names(candidatePath));
	const removed = baseline.filter((name) => !candidate.has(name));
	if (removed.length > 0) fail(`${candidatePath}: removed exports vs baseline: ${removed.join(", ")}`);
}

async function main(argv) {
	const failures = [];
	const fail = (message) => {
		failures.push(message);
	};
	try {
		const args = parseArgs(argv);
		runSourceChecks(args.root, args, fail);
		if (args.compareExports !== undefined) await compareExports(args.compareExports, fail);
	} catch (error) {
		fail(`fork-preservation-check error: ${error instanceof Error ? error.message : String(error)}`);
	}
	console.log(JSON.stringify({ pass: failures.length === 0, failures }));
	return failures.length === 0 ? 0 : 1;
}

process.exit(await main(process.argv.slice(2)));
