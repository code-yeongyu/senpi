/**
 * Live probe for the keyless web search engines (senpi#2339). Not part of the test suite: it reaches the
 * real search sites. Each engine is queried once on its own, then the default chain runs once.
 *
 *   bun packages/coding-agent/test/manual-qa/websearch-free-engines-probe.ts ["query"]
 *   SEARXNG_URL=http://localhost:8888 bun packages/coding-agent/test/manual-qa/websearch-free-engines-probe.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadWebsearchConfig } from "../../src/core/extensions/builtin/websearch/websearch/config.ts";
import {
	createSearchRoutingState,
	formatSearchText,
	performSearch,
} from "../../src/core/extensions/builtin/websearch/websearch/search.ts";
import type {
	SearchProviderEntry,
	WebsearchConfig,
} from "../../src/core/extensions/builtin/websearch/websearch/types.ts";

const query = process.argv[2] ?? "typescript satisfies operator";
const request = { query, maxResults: 5 };

const engines: SearchProviderEntry[] = [
	{ provider: "duckduckgo-html" },
	{ provider: "exa-mcp" },
	{ provider: "startpage" },
	{ provider: "mojeek" },
	{ provider: "ecosia" },
	{ provider: "google-html" },
];
if (process.env.SEARXNG_URL) engines.push({ provider: "searxng", baseUrl: process.env.SEARXNG_URL });

console.log(`# Keyless engine probe, query "${query}", ${new Date().toISOString()}`);
for (const engine of engines) {
	const config: WebsearchConfig = { strategy: "priority", fallback: false, auto: false, providers: [engine] };
	const details = await performSearch(config, request, undefined, createSearchRoutingState(1));
	const outcome = details.error
		? `${details.blocked ? `BLOCKED(${details.blocked})` : "FAILED"} ${details.error}`
		: `OK ${details.results.length} results; first: ${details.results[0]?.title} <${details.results[0]?.url}>`;
	console.log(`- ${engine.provider} [${details.durationMs}ms] ${outcome}`);
}

const emptyHome = mkdtempSync(join(tmpdir(), "websearch-probe-"));
try {
	const loaded = await loadWebsearchConfig({ cwd: emptyHome, homeDir: emptyHome });
	if (!loaded.ok) throw new Error(loaded.message);
	console.log(`\n# Default chain with no websearch.json (${loaded.source})`);
	const details = await performSearch(
		loaded.config,
		request,
		undefined,
		createSearchRoutingState(loaded.config.providers.length),
	);
	console.log(formatSearchText(details));
} finally {
	rmSync(emptyHome, { recursive: true, force: true });
}
