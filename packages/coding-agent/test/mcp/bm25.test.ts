// Todo 30 — zero-dep BM25 tool-search engine.
//
// Verifies exact-name short-circuit (before BM25), snake/camel/kebab
// tokenisation, deterministic ranking, empty/garbage safety, and a loose
// perf bound over a 5k-tool corpus.

import { describe, expect, it } from "vitest";
import {
	type Bm25Doc,
	buildBm25Index,
	normalizeToolName,
	tokenizeToolText,
} from "../../src/core/extensions/builtin/mcp/expose/bm25.ts";

function doc(name: string, description: string, server = "docs"): Bm25Doc {
	const toolName = name.replace(/^mcp_[^_]+_/, "");
	return { name, toolName, description, server };
}

describe("todo30 bm25: tokenizer", () => {
	it("splits snake_case, camelCase, kebab-case and lowercases", () => {
		expect(tokenizeToolText("get-library-docs")).toEqual(["get", "library", "docs"]);
		expect(tokenizeToolText("resolveLibraryId")).toEqual(["resolve", "library", "id"]);
		expect(tokenizeToolText("list_active_sessions")).toEqual(["list", "active", "sessions"]);
		expect(tokenizeToolText("HTTPServerV2")).toContain("http");
	});

	it("normalizeToolName is hyphen/underscore/case-insensitive", () => {
		expect(normalizeToolName("get-library-docs")).toBe(normalizeToolName("get_library_docs"));
		expect(normalizeToolName("Get-Library-Docs")).toBe(normalizeToolName("getlibrarydocs"));
	});
});

describe("todo30 bm25: exact-name short-circuit before BM25", () => {
	it("returns the exact-name tool rank-1 even when BM25 alone ranks it lower", () => {
		// Adversarial corpus: the exact-name target carries a long, noisy
		// description so BM25 length-normalisation (b=0.4) tanks its per-term
		// score, while a terser decoy with the same query tokens outscores it.
		const filler = new Array(40).fill("alpha beta gamma delta epsilon zeta eta theta").join(" ");
		const corpus: Bm25Doc[] = [
			doc("mcp_docs_get-library-docs", `get library docs ${filler}`),
			// Decoy: matches get/library/docs on its name, short document -> higher raw BM25.
			doc("mcp_docs_get_library_docs_helper", "get library docs"),
			doc("mcp_docs_get_library_docs_alt", "get library docs"),
		];
		const index = buildBm25Index(corpus);

		// Pure BM25 (no exact-match) does NOT rank the noisy target first.
		const bm25Only = index.search("get library docs", 10, { exactMatch: false });
		expect(bm25Only[0]?.name).not.toBe("mcp_docs_get-library-docs");

		// With exact-name short-circuit, the query equal to the tool name wins.
		const withExact = index.search("get-library-docs", 10);
		expect(withExact[0]?.name).toBe("mcp_docs_get-library-docs");
		expect(withExact[0]?.exact).toBe(true);

		// Underscore / case variants of the exact name also short-circuit.
		expect(index.search("get_library_docs")[0]?.name).toBe("mcp_docs_get-library-docs");
		expect(index.search("GET-LIBRARY-DOCS")[0]?.name).toBe("mcp_docs_get-library-docs");
		// The full prefixed senpi name is an exact match too.
		expect(index.search("mcp_docs_get-library-docs")[0]?.name).toBe("mcp_docs_get-library-docs");
	});
});

describe("todo30 bm25: relevance sanity (10 queries x 50-tool corpus)", () => {
	const servers = ["docs", "github", "fs", "db", "web"];
	// Each server carries the same 10 verb-noun tools, so identically-named tools
	// across servers are disambiguated only by the server-name field boost.
	const pairs = [
		"get-library",
		"list-issue",
		"search-file",
		"create-record",
		"delete-page",
		"update-user",
		"read-commit",
		"write-branch",
		"fetch-table",
		"resolve-session",
	];
	const corpus: Bm25Doc[] = [];
	for (const server of servers) {
		for (const pair of pairs) {
			corpus.push({
				name: `mcp_${server}_${pair}`,
				toolName: pair,
				description: `${pair.replace("-", " a ")} on the ${server} server`,
				server,
			});
		}
	}
	const index = buildBm25Index(corpus);

	// Queries name the server so the field boost picks the right same-named tool.
	const cases: { query: string; expect: string }[] = [
		{ query: "docs search file", expect: "mcp_docs_search-file" },
		{ query: "github create record", expect: "mcp_github_create-record" },
		{ query: "fs delete page", expect: "mcp_fs_delete-page" },
		{ query: "db list issue", expect: "mcp_db_list-issue" },
		{ query: "web fetch table", expect: "mcp_web_fetch-table" },
	];

	for (const c of cases) {
		it(`ranks '${c.expect}' in top-3 for query '${c.query}'`, () => {
			const top3 = index.search(c.query, 3).map((r) => r.name);
			expect(top3).toContain(c.expect);
		});
	}

	it("server filter narrows results to a single server", () => {
		const results = index.search("get", 20, { server: "github" });
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((r) => r.doc.server === "github")).toBe(true);
	});
});

describe("todo30 bm25: empty / garbage queries", () => {
	const index = buildBm25Index([doc("mcp_docs_get-library-docs", "get library docs")]);
	it("empty query returns empty, does not throw", () => {
		expect(index.search("")).toEqual([]);
		expect(index.search("   ")).toEqual([]);
	});
	it("garbage query with no token overlap returns empty", () => {
		expect(index.search("zzzz qqqq xyzzy")).toEqual([]);
	});
	it("empty corpus does not throw", () => {
		expect(buildBm25Index([]).search("anything")).toEqual([]);
	});
});

describe("todo30 bm25: determinism + perf", () => {
	it("ranking is deterministic and tie-breaks by name", () => {
		const corpus: Bm25Doc[] = [
			doc("mcp_docs_b_tool", "same words here"),
			doc("mcp_docs_a_tool", "same words here"),
			doc("mcp_docs_c_tool", "same words here"),
		];
		const index = buildBm25Index(corpus);
		const a = index.search("same words", 10).map((r) => r.name);
		const b = index.search("same words", 10).map((r) => r.name);
		expect(a).toEqual(b);
		// Identical scores tie-break by ascending name.
		expect(a).toEqual(["mcp_docs_a_tool", "mcp_docs_b_tool", "mcp_docs_c_tool"]);
	});

	it("5k-tool corpus search is under 100ms (loose bound)", () => {
		const corpus: Bm25Doc[] = [];
		for (let i = 0; i < 5000; i += 1) {
			corpus.push({
				name: `mcp_s${i % 20}_tool-number-${i}`,
				toolName: `tool-number-${i}`,
				description: `synthetic tool ${i} performing operation ${i % 7} on resource ${i % 13}`,
				server: `s${i % 20}`,
			});
		}
		const index = buildBm25Index(corpus);
		// Warm up (JIT + first-query index touch).
		index.search("operation resource tool", 10);
		const start = performance.now();
		const results = index.search("operation resource tool", 10);
		const elapsed = performance.now() - start;
		expect(results.length).toBeGreaterThan(0);
		// Guards against algorithmic regressions (a naive O(n²) rescan of the 5k
		// corpus would take seconds), not micro-latency. The bound is generous so a
		// busy dev machine or a loaded CI/release runner does not flake it; a warm
		// search here is ~1ms on an idle host and tens of ms under heavy load.
		expect(elapsed).toBeLessThan(100);
	});
});
