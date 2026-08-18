import { describe, expect, it } from "vitest";
import {
	buildBm25Index,
	normalizeToolName,
	tokenizeToolText,
} from "../../src/core/extensions/builtin/tool-search/engine/bm25.ts";
import type {
	ToolSearchDocument,
	ToolSearchSource,
} from "../../src/core/extensions/builtin/tool-search/engine/document.ts";

function toolDoc(name: string, overrides: Partial<Omit<ToolSearchDocument, "name">> = {}): ToolSearchDocument {
	return {
		name,
		label: name,
		aliases: [],
		keywords: [],
		source: "extension",
		group: "utilities",
		ownerLabel: "Utilities",
		registrationId: `registration:${name}`,
		...overrides,
	};
}

function mcpDoc(name: string, description: string, server = "docs"): ToolSearchDocument {
	const toolName = name.replace(/^mcp_[^_]+_/, "");
	return {
		name,
		label: toolName,
		aliases: [toolName],
		description,
		keywords: [],
		source: "mcp",
		group: server,
		ownerLabel: server,
		registrationId: `mcp:${server}:${toolName}`,
	};
}

function resultNames(results: readonly { name: string }[]): string[] {
	return results.map((result) => result.name);
}

describe("tool-search bm25 tokenizer", () => {
	it("splits snake_case, camelCase, kebab-case and lowercases", () => {
		expect(tokenizeToolText("get-library-docs")).toEqual(["get", "library", "docs"]);
		expect(tokenizeToolText("resolveLibraryId")).toEqual(["resolve", "library", "id"]);
		expect(tokenizeToolText("list_active_sessions")).toEqual(["list", "active", "sessions"]);
		expect(tokenizeToolText("HTTPServerV2")).toContain("http");
	});

	it("normalizes names without sensitivity to separators or case", () => {
		expect(normalizeToolName("get-library-docs")).toBe(normalizeToolName("get_library_docs"));
		expect(normalizeToolName("Get-Library-Docs")).toBe(normalizeToolName("getlibrarydocs"));
	});
});

describe("tool-search bm25 MCP-shaped documents", () => {
	const servers = ["docs", "github", "fs", "db", "web"];
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
	const corpus = servers.flatMap((server) =>
		pairs.map((pair) =>
			mcpDoc(`mcp_${server}_${pair}`, `${pair.replace("-", " a ")} on the ${server} server`, server),
		),
	);
	const toolIndex = buildBm25Index(corpus);

	for (const { query, expected } of [
		{ query: "docs search file", expected: "mcp_docs_search-file" },
		{ query: "github create record", expected: "mcp_github_create-record" },
		{ query: "fs delete page", expected: "mcp_fs_delete-page" },
		{ query: "db list issue", expected: "mcp_db_list-issue" },
		{ query: "web fetch table", expected: "mcp_web_fetch-table" },
	]) {
		it(`ranks '${expected}' in the top three for '${query}'`, () => {
			expect(resultNames(toolIndex.search(query, 3))).toContain(expected);
		});
	}

	it("uses group as the MCP server filter", () => {
		const results = toolIndex.search("get", 20, { group: "github" });
		expect(results.length).toBeGreaterThan(0);
		expect(results.every((result) => result.doc.group === "github")).toBe(true);
	});

	it("preserves the exact-name short-circuit before BM25", () => {
		const filler = new Array(40).fill("alpha beta gamma delta epsilon zeta eta theta").join(" ");
		const index = buildBm25Index([
			mcpDoc("mcp_docs_get-library-docs", `get library docs ${filler}`),
			mcpDoc("mcp_docs_get_library_docs_helper", "get library docs"),
			mcpDoc("mcp_docs_get_library_docs_alt", "get library docs"),
		]);

		expect(index.search("get library docs", 10, { exactMatch: false })[0]?.name).not.toBe(
			"mcp_docs_get-library-docs",
		);
		for (const query of ["get-library-docs", "get_library_docs", "GET-LIBRARY-DOCS", "mcp_docs_get-library-docs"]) {
			expect(index.search(query)[0]).toMatchObject({ exact: true, name: "mcp_docs_get-library-docs" });
		}
	});
});

describe("tool-search bm25 generalized fields and filters", () => {
	it("extends normalized exact matching to label, aliases, and keywords", () => {
		const index = buildBm25Index([
			toolDoc("extension_lookup", {
				label: "Find Package",
				aliases: ["resolve-library-id"],
				keywords: ["dependency catalog"],
			}),
		]);

		for (const query of ["find_package", "RESOLVE LIBRARY ID", "dependency-catalog"]) {
			expect(index.search(query)[0]).toMatchObject({ exact: true, name: "extension_lookup" });
		}
	});

	it("ranks keyword hits at least as high as description-only hits", () => {
		const index = buildBm25Index([
			toolDoc("keyword_match", { keywords: ["ledger"], ownerLabel: "Owner" }),
			toolDoc("description_match", { description: "ledger", ownerLabel: "Owner" }),
		]);
		const results = index.search("ledger", 10, { exactMatch: false });
		const keyword = results.find((result) => result.name === "keyword_match");
		const description = results.find((result) => result.name === "description_match");

		expect(keyword).toBeDefined();
		expect(description).toBeDefined();
		expect(keyword?.score).toBeGreaterThanOrEqual(description?.score ?? Number.POSITIVE_INFINITY);
		expect(results[0]?.name).toBe("keyword_match");
	});

	it("indexes group, owner label, description, and supplemental search text", () => {
		const index = buildBm25Index([
			toolDoc("group_hit", { group: "payments" }),
			toolDoc("owner_hit", { ownerLabel: "Accounting" }),
			toolDoc("description_hit", { description: "invoices" }),
			toolDoc("search_text_hit", { searchText: "reconciliation" }),
		]);

		expect(index.search("payments")[0]?.name).toBe("group_hit");
		expect(index.search("accounting")[0]?.name).toBe("owner_hit");
		expect(index.search("invoices")[0]?.name).toBe("description_hit");
		expect(index.search("reconciliation")[0]?.name).toBe("search_text_hit");
	});

	it("restricts results independently by source and group", () => {
		const docs: ToolSearchDocument[] = [
			toolDoc("mcp_docs_search", { source: "mcp", group: "docs", description: "search" }),
			toolDoc("extension_docs_search", { source: "extension", group: "docs", description: "search" }),
			toolDoc("extension_files_search", { source: "extension", group: "files", description: "search" }),
		];
		const index = buildBm25Index(docs);

		expect(
			index.search("search", 10, { source: "extension" }).every((result) => result.doc.source === "extension"),
		).toBe(true);
		expect(index.search("search", 10, { group: "docs" }).every((result) => result.doc.group === "docs")).toBe(true);
		expect(resultNames(index.search("search", 10, { source: "extension", group: "docs" }))).toEqual([
			"extension_docs_search",
		]);
	});

	it("does not use source as a ranking signal", () => {
		const shared = { description: "catalog lookup", group: "catalog", ownerLabel: "Catalog" } as const;
		const index = buildBm25Index([
			toolDoc("a_extension", { ...shared, source: "extension" }),
			toolDoc("b_mcp", { ...shared, source: "mcp" }),
		]);
		const results = index.search("catalog lookup", 10, { exactMatch: false });

		expect(results[0]?.score).toBe(results[1]?.score);
		expect(resultNames(results)).toEqual(["a_extension", "b_mcp"]);
	});

	it("keeps source filter-only when it is the sole query match", () => {
		const shared = {
			group: "utilities",
			ownerLabel: "Core",
			description: "catalog lookup",
			searchText: "package records",
		} as const;
		const index = buildBm25Index([
			toolDoc("alpha_tool", { ...shared, label: "Alpha Tool", source: "extension" }),
			toolDoc("beta_tool", { ...shared, label: "Beta Tool", source: "mcp" }),
		]);

		expect(index.search("extension", 10, { exactMatch: false })).toEqual([]);
		expect(index.search("mcp", 10, { exactMatch: false })).toEqual([]);
	});

	it("weights group and owner-label hits above description-only hits", () => {
		const index = buildBm25Index([
			toolDoc("description_candidate", {
				label: "plain",
				group: "plain",
				ownerLabel: "plain",
				description: "routing",
			}),
			toolDoc("group_candidate", {
				label: "plain",
				group: "routing",
				ownerLabel: "plain",
				description: "plain",
			}),
			toolDoc("owner_candidate", {
				label: "plain",
				group: "plain",
				ownerLabel: "routing",
				description: "plain",
			}),
		]);

		expect(resultNames(index.search("routing", 10, { exactMatch: false }))).toEqual([
			"group_candidate",
			"owner_candidate",
			"description_candidate",
		]);
	});
});

describe("tool-search bm25 malformed input and determinism", () => {
	it("returns sensible empty results for empty, punctuation-only, stopword-only, and missing optional text", () => {
		const index = buildBm25Index([toolDoc("bare_tool", { description: undefined, searchText: undefined })]);

		expect(index.search("")).toEqual([]);
		expect(index.search("   ")).toEqual([]);
		expect(index.search("--- !!! ???")).toEqual([]);
		expect(index.search("the and or")).toEqual([]);
		expect(index.search("bare")[0]?.name).toBe("bare_tool");
		expect(buildBm25Index([]).search("anything")).toEqual([]);
	});

	it("does not mutate stale index state and returns byte-identical deterministic ordering", () => {
		const corpus = [
			toolDoc("b_tool", { description: "same words here" }),
			toolDoc("a_tool", { description: "same words here" }),
			toolDoc("c_tool", { description: "same words here" }),
		];
		const index = buildBm25Index(corpus);
		const first = index.search("same words", 10);
		const second = index.search("same words", 10);

		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(resultNames(first)).toEqual(["a_tool", "b_tool", "c_tool"]);
		expect(corpus.map((doc) => doc.name)).toEqual(["b_tool", "a_tool", "c_tool"]);
	});
});

describe("tool-search bm25 mixed-corpus QA", () => {
	it("prints representative rankings and visibly exercises keyword weighting and source filtering", () => {
		const mixed: ToolSearchDocument[] = [
			toolDoc("mcp_docs_library", {
				label: "library",
				source: "mcp",
				group: "docs",
				ownerLabel: "Docs MCP",
				description: "resolve package documentation",
			}),
			toolDoc("mcp_git_commits", {
				label: "commits",
				source: "mcp",
				group: "git",
				ownerLabel: "Git MCP",
				description: "inspect repository history",
			}),
			toolDoc("mcp_db_query", {
				label: "query",
				source: "mcp",
				group: "database",
				ownerLabel: "Database MCP",
				description: "run relational statements",
			}),
			toolDoc("extension_ledger_keyword", {
				label: "bookkeeping",
				group: "finance",
				ownerLabel: "Finance Extension",
				keywords: ["ledger"],
			}),
			toolDoc("extension_ledger_description", {
				label: "journal",
				group: "finance",
				ownerLabel: "Finance Extension",
				description: "ledger",
			}),
			toolDoc("extension_package_audit", {
				label: "package audit",
				group: "dependencies",
				ownerLabel: "Dependency Extension",
				searchText: "find vulnerable libraries",
			}),
		];
		const index = buildBm25Index(mixed);
		const queries: { query: string; source?: ToolSearchSource }[] = [
			{ query: "ledger" },
			{ query: "library" },
			{ query: "library", source: "extension" },
		];

		for (const { query, source } of queries) {
			const rows = index.search(query, 6, { source }).map((result, rank) => ({
				rank: rank + 1,
				name: result.name,
				source: result.doc.source,
				group: result.doc.group,
				score: result.score.toFixed(6),
			}));
			console.log(`\nquery=${JSON.stringify(query)} source=${source ?? "all"}`);
			console.table(rows);
			if (source !== undefined) expect(rows.every((row) => row.source === source)).toBe(true);
		}

		const ledger = index.search("ledger", 6, { exactMatch: false });
		expect(resultNames(ledger).slice(0, 2)).toEqual(["extension_ledger_keyword", "extension_ledger_description"]);
		expect(index.search("library", 6, { source: "extension" }).some((result) => result.doc.source === "mcp")).toBe(
			false,
		);
	});
});
