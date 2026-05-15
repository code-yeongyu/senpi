import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "../../types.js";

const ENABLE_ENV = "PI_KIMI_WEB_SEARCH";
const SEARCH_BASE_URL_ENV = "PI_KIMI_SEARCH_BASE_URL";
const FETCH_BASE_URL_ENV = "PI_KIMI_FETCH_BASE_URL";
const DEFAULT_SEARCH_URL = "https://api.kimi.com/coding/v1/search";
const DEFAULT_FETCH_URL = "https://api.kimi.com/coding/v1/fetch";

function parseEnableEnv(envVar: string): boolean {
	const envValue = process.env[envVar];
	if (!envValue) {
		return true;
	}
	const normalized = envValue.trim().toLowerCase();
	if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
		return false;
	}
	if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
		return true;
	}
	return true;
}

function isEnabled(): boolean {
	return parseEnableEnv(ENABLE_ENV);
}

function getSearchBaseUrl(): string {
	return process.env[SEARCH_BASE_URL_ENV] || DEFAULT_SEARCH_URL;
}

function getFetchBaseUrl(): string {
	return process.env[FETCH_BASE_URL_ENV] || DEFAULT_FETCH_URL;
}

async function resolveApiKey(ctx: ExtensionContext): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) {
		return undefined;
	}
	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (auth.ok && auth.apiKey) {
			return auth.apiKey;
		}
	} catch {
		// ignore
	}
	return undefined;
}

const searchWebSchema = Type.Object({
	query: Type.String({ description: "The query text to search for." }),
	limit: Type.Optional(
		Type.Number({
			description:
				"The number of results to return. Typically you do not need to set this value. When the results do not contain what you need, you probably want to give a more concrete query.",
			default: 5,
			minimum: 1,
			maximum: 20,
		}),
	),
	include_content: Type.Optional(
		Type.Boolean({
			description:
				"Whether to include the content of the web pages in the results. It can consume a large amount of tokens when this is set to True. You should avoid enabling this when limit is set to a large value.",
			default: false,
		}),
	),
});

type SearchWebInput = Static<typeof searchWebSchema>;

const fetchUrlSchema = Type.Object({
	url: Type.String({ description: "The URL to fetch content from." }),
});

type FetchUrlInput = Static<typeof fetchUrlSchema>;

interface SearchResult {
	title?: string;
	url?: string;
	summary?: string;
	content?: string;
}

interface SearchResponse {
	search_results?: SearchResult[];
	answer?: string;
	error?: string;
}

interface FetchResponse {
	content?: string;
	markdown?: string;
	error?: string;
}

async function callKimiSearch(
	apiKey: string,
	toolCallId: string,
	params: SearchWebInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<{ results: SearchResult[]; answer?: string }>> {
	const baseUrl = getSearchBaseUrl();
	const body = {
		text_query: params.query,
		limit: params.limit ?? 5,
		enable_page_crawling: params.include_content ?? false,
		timeout_seconds: 30,
	};

	const response = await fetch(baseUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			"X-Msh-Tool-Call-Id": toolCallId,
		},
		body: JSON.stringify(body),
		signal,
	} as RequestInit);

	if (!response.ok) {
		const text = await response.text().catch(() => "Unknown error");
		throw new Error(`Search service HTTP ${response.status}: ${text}`);
	}

	const data = (await response.json()) as SearchResponse;

	if (data.error) {
		throw new Error(`Search service error: ${data.error}`);
	}

	const results = data.search_results ?? [];
	const answer = data.answer;

	let outputText = "";
	if (answer) {
		outputText += `Answer: ${answer}\n\n`;
	}
	if (results.length > 0) {
		outputText += "Search results:\n";
		for (const result of results) {
			outputText += `- ${result.title || "Untitled"}\n`;
			outputText += `  URL: ${result.url || "N/A"}\n`;
			if (result.summary) {
				outputText += `  Summary: ${result.summary}\n`;
			}
			if (result.content) {
				outputText += `  Content: ${result.content}\n`;
			}
			outputText += "\n";
		}
	} else {
		outputText += "No search results found.\n";
	}

	return {
		content: [{ type: "text", text: outputText } as TextContent],
		details: { results, answer },
	};
}

async function callKimiFetch(
	apiKey: string,
	toolCallId: string,
	params: FetchUrlInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<{ url: string; content: string }>> {
	const baseUrl = getFetchBaseUrl();
	const body = {
		url: params.url,
	};

	const response = await fetch(baseUrl, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			"X-Msh-Tool-Call-Id": toolCallId,
		},
		body: JSON.stringify(body),
		signal,
	} as RequestInit);

	if (!response.ok) {
		// Fallback: try local fetch
		const localResponse = await fetch(params.url, {
			method: "GET",
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
			},
			signal,
		} as RequestInit);
		if (!localResponse.ok) {
			throw new Error(`Fetch URL failed: service HTTP ${response.status}, local HTTP ${localResponse.status}`);
		}
		const text = await localResponse.text();
		return {
			content: [{ type: "text", text } as TextContent],
			details: { url: params.url, content: text },
		};
	}

	const data = (await response.json()) as FetchResponse;

	if (data.error) {
		throw new Error(`Fetch service error: ${data.error}`);
	}

	const content = data.markdown || data.content || "";

	return {
		content: [{ type: "text", text: content } as TextContent],
		details: { url: params.url, content },
	};
}

export default function kimiWebSearchExtension(pi: ExtensionAPI): void {
	if (!isEnabled()) {
		return;
	}

	pi.registerTool({
		name: "SearchWeb",
		label: "SearchWeb",
		description:
			"WebSearch tool allows you to search on the internet to get latest information, including news, documents, release notes, blog posts, papers, etc.",
		promptSnippet: "SearchWeb — search the internet for current information",
		parameters: searchWebSchema,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = await resolveApiKey(ctx);
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Search service is not configured. No API key found for Kimi provider.",
						} as TextContent,
					],
					details: { results: [], error: "No API key" },
				};
			}
			return callKimiSearch(apiKey, toolCallId, params, signal);
		},
	});

	pi.registerTool({
		name: "FetchURL",
		label: "FetchURL",
		description: "FetchURL tool allows you to fetch content from a URL.",
		promptSnippet: "FetchURL — fetch web page content from a URL",
		parameters: fetchUrlSchema,
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = await resolveApiKey(ctx);
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Fetch service is not configured. No API key found for Kimi provider.",
						} as TextContent,
					],
					details: { url: params.url, content: "", error: "No API key" },
				};
			}
			return callKimiFetch(apiKey, toolCallId, params, signal);
		},
	});
}
