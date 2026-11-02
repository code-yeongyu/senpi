/**
 * One-shot model discovery for an OpenAI-compatible provider in models.json (senpi#2196).
 *
 * `GET <baseUrl>/models` is fetched once and every listed id is upserted into the provider's
 * `models` array. When the provider opts in with `compat.supportsReasoningEffort: true`, the
 * `reasoning_efforts` an entry advertises become that model's `thinkingLevelMap` (endpoint
 * spelling kept, unadvertised levels vetoed) and its `default` becomes `defaultThinkingLevel`.
 * Discovery owns `reasoning`, `thinkingLevelMap`, and `defaultThinkingLevel` of a model that advertises
 * efforts; every other field is left exactly as the user wrote them.
 */

import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
	type EndpointReasoningEfforts,
	type ModelThinkingLevel,
	normalizeProviderId,
	type ProviderHeaders,
	parseEndpointReasoningEfforts,
} from "@earendil-works/pi-ai";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";
import { ModelConfig } from "./model-config.ts";
import { type ListingUrl, listingUrl, redactUrlInMessage } from "./model-discovery-url.ts";
import { uniqueBackupPath } from "./models-json-migration.ts";

export interface ModelsDiscoveryAuth {
	apiKey?: string;
	/** A `null` value removes a header, as for provider requests. */
	headers?: ProviderHeaders;
}

export interface DiscoveredEfforts {
	/** Levels the endpoint advertised, in senpi order. */
	levels: ModelThinkingLevel[];
	defaultThinkingLevel?: ModelThinkingLevel;
	unmapped: string[];
}

export interface ModelsDiscoveryReport {
	providerId: string;
	url: string;
	modelsPath: string;
	added: string[];
	updated: string[];
	unchanged: string[];
	/** Configured ids the endpoint did not list; kept untouched. */
	unlisted: string[];
	efforts: Record<string, DiscoveredEfforts>;
	/** The listing advertised efforts but the provider did not opt in, so they were not used. */
	effortsIgnored: boolean;
	written: boolean;
	backupPath?: string;
	/** The rewritten file lost comments the original had; the backup keeps them. */
	commentsDropped: boolean;
}

export interface DiscoverProviderModelsOptions {
	providerId: string;
	modelsPath: string;
	auth: ModelsDiscoveryAuth;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

export class ModelsDiscoveryError extends Error {}

type JsonRecord = Record<string, unknown>;
interface ListedModel {
	id: string;
	reasoningEfforts: unknown;
}

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const OPENAI_COMPATIBLE_APIS = new Set(["openai-completions", "openai-responses"]);

const isRecord = (value: unknown): value is JsonRecord =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function readDocument(modelsPath: string): { content: string; document: JsonRecord } {
	let content: string;
	try {
		content = readFileSync(modelsPath, "utf-8");
	} catch (error) {
		throw new ModelsDiscoveryError(`Cannot read ${modelsPath}: ${error instanceof Error ? error.message : error}`);
	}
	let document: unknown;
	try {
		document = JSON.parse(stripJsonComments(stripBom(content)));
	} catch (error) {
		throw new ModelsDiscoveryError(`Cannot parse ${modelsPath}: ${error instanceof Error ? error.message : error}`);
	}
	if (!isRecord(document)) throw new ModelsDiscoveryError(`${modelsPath} is not a JSON object`);
	return { content, document };
}

interface ConfiguredProvider {
	key: string;
	providers: JsonRecord;
	provider: JsonRecord;
}

function findProvider(document: JsonRecord, providerId: string, modelsPath: string): ConfiguredProvider {
	const wanted = normalizeProviderId(providerId);
	const providers = isRecord(document.providers) ? document.providers : {};
	const key = Object.keys(providers).find((candidate) => normalizeProviderId(candidate) === wanted);
	const provider = key === undefined ? undefined : providers[key];
	if (key === undefined || !isRecord(provider)) {
		throw new ModelsDiscoveryError(`Provider "${providerId}" is not defined in ${modelsPath}`);
	}
	return { key, providers, provider };
}

function providerListingUrl(provider: JsonRecord, providerId: string): ListingUrl {
	if (typeof provider.api === "string" && !OPENAI_COMPATIBLE_APIS.has(provider.api)) {
		throw new ModelsDiscoveryError(
			`Provider "${providerId}" uses api "${provider.api}", not an OpenAI-compatible api`,
		);
	}
	if (typeof provider.baseUrl !== "string" || provider.baseUrl.trim() === "") {
		throw new ModelsDiscoveryError(`Provider "${providerId}" needs a "baseUrl" to discover models`);
	}
	const url = listingUrl(provider.baseUrl);
	if (!url) throw new ModelsDiscoveryError(`Provider "${providerId}" has a "baseUrl" that is not a valid URL`);
	return url;
}

async function fetchListing(
	url: ListingUrl,
	auth: ModelsDiscoveryAuth,
	fetchImpl: typeof fetch,
	signal: AbortSignal | undefined,
): Promise<ListedModel[]> {
	const headers: Record<string, string> = { accept: "application/json" };
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (value === null) delete headers[name];
		else headers[name] = value;
	}
	if (auth.apiKey && !Object.keys(headers).some((name) => name.toLowerCase() === "authorization")) {
		headers.authorization = `Bearer ${auth.apiKey}`;
	}
	let response: Response;
	try {
		response = await fetchImpl(url.request, { headers, signal });
	} catch (error) {
		const reason = redactUrlInMessage(error instanceof Error ? error.message : String(error), url);
		throw new ModelsDiscoveryError(`GET ${url.display} failed: ${reason}`);
	}
	if (!response.ok) throw new ModelsDiscoveryError(`GET ${url.display} failed: HTTP ${response.status}`);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new ModelsDiscoveryError(`GET ${url.display} did not return JSON`);
	}
	const data = Array.isArray(payload) ? payload : isRecord(payload) ? payload.data : undefined;
	if (!Array.isArray(data)) throw new ModelsDiscoveryError(`GET ${url.display} did not return a model list`);
	const listed = new Map<string, ListedModel>();
	for (const entry of data) {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id.trim() === "") continue;
		if (!listed.has(entry.id)) listed.set(entry.id, { id: entry.id, reasoningEfforts: entry.reasoning_efforts });
	}
	return [...listed.values()];
}

function describeEfforts(parsed: EndpointReasoningEfforts): DiscoveredEfforts {
	const map = parsed.thinkingLevelMap ?? {};
	const levels = THINKING_LEVELS.filter((level) => typeof map[level] === "string");
	return parsed.defaultThinkingLevel === undefined
		? { levels, unmapped: parsed.unmapped }
		: { levels, defaultThinkingLevel: parsed.defaultThinkingLevel, unmapped: parsed.unmapped };
}

/**
 * Discovery owns `reasoning`, `thinkingLevelMap`, and `defaultThinkingLevel` of a model whose
 * listing advertises efforts; absent metadata leaves the entry alone. An advertised ladder with no
 * value senpi can represent turns the controls off rather than keeping a stale map.
 */
function withEfforts(entry: JsonRecord, parsed: EndpointReasoningEfforts | undefined): JsonRecord {
	if (!parsed) return entry;
	const { defaultThinkingLevel: _previousDefault, thinkingLevelMap: _previousMap, ...rest } = entry;
	if (!parsed.thinkingLevelMap) return { ...rest, reasoning: false };
	return parsed.defaultThinkingLevel === undefined
		? { ...rest, reasoning: true, thinkingLevelMap: parsed.thinkingLevelMap }
		: {
				...rest,
				reasoning: true,
				thinkingLevelMap: parsed.thinkingLevelMap,
				defaultThinkingLevel: parsed.defaultThinkingLevel,
			};
}

function writeWithBackup(modelsPath: string, original: string, next: string): string {
	const backupPath = uniqueBackupPath(modelsPath);
	const temporary = `${modelsPath}.${process.pid}.tmp`;
	const mode = statSync(modelsPath).mode & 0o777;
	writeFileSync(backupPath, original, { encoding: "utf-8", mode, flag: "wx" });
	try {
		writeFileSync(temporary, next, { encoding: "utf-8", mode, flag: "wx" });
		chmodSync(temporary, mode);
		if (readFileSync(modelsPath, "utf-8") !== original) {
			throw new ModelsDiscoveryError(`${modelsPath} changed during discovery; nothing was written`);
		}
		renameSync(temporary, modelsPath);
		return backupPath;
	} catch (error) {
		rmSync(temporary, { force: true });
		rmSync(backupPath, { force: true });
		throw error;
	}
}

/** Fetch the provider's model listing once and upsert it into models.json. */
export async function discoverProviderModels(options: DiscoverProviderModelsOptions): Promise<ModelsDiscoveryReport> {
	const { content, document } = readDocument(options.modelsPath);
	const { key: providerKey, providers, provider } = findProvider(document, options.providerId, options.modelsPath);
	const url = providerListingUrl(provider, options.providerId);
	const listing = await fetchListing(url, options.auth, options.fetch ?? fetch, options.signal);

	const honorEfforts = isRecord(provider.compat) && provider.compat.supportsReasoningEffort === true;
	const configured = Array.isArray(provider.models) ? [...provider.models] : [];
	const report: ModelsDiscoveryReport = {
		providerId: providerKey,
		url: url.display,
		modelsPath: options.modelsPath,
		added: [],
		updated: [],
		unchanged: [],
		unlisted: [],
		efforts: {},
		effortsIgnored: false,
		written: false,
		commentsDropped: false,
	};
	for (const listed of listing) {
		const parsed = honorEfforts ? parseEndpointReasoningEfforts(listed.reasoningEfforts) : undefined;
		if (!honorEfforts && Array.isArray(listed.reasoningEfforts)) report.effortsIgnored = true;
		if (parsed) report.efforts[listed.id] = describeEfforts(parsed);
		const index = configured.findIndex((entry) => isRecord(entry) && entry.id === listed.id);
		const existing = index >= 0 ? configured[index] : undefined;
		const current = isRecord(existing) ? existing : undefined;
		const next = withEfforts(current ?? { id: listed.id }, parsed);
		if (current === undefined) {
			configured.push(next);
			report.added.push(listed.id);
		} else if (isDeepStrictEqual(current, next)) {
			report.unchanged.push(listed.id);
		} else {
			configured[index] = next;
			report.updated.push(listed.id);
		}
	}
	const listedIds = new Set(listing.map((listed) => listed.id));
	for (const entry of configured) {
		if (isRecord(entry) && typeof entry.id === "string" && !listedIds.has(entry.id)) report.unlisted.push(entry.id);
	}
	if (report.added.length === 0 && report.updated.length === 0) return report;

	const nextDocument = {
		...document,
		providers: { ...providers, [providerKey]: { ...provider, models: configured } },
	};
	const nextContent = `${JSON.stringify(nextDocument, null, 2)}\n`;
	const invalid = ModelConfig.validationError(nextContent, options.modelsPath);
	if (invalid !== undefined) {
		throw new ModelsDiscoveryError(
			`Discovery would leave an invalid models.json, so nothing was written.\n${invalid}`,
		);
	}
	report.backupPath = writeWithBackup(options.modelsPath, content, nextContent);
	report.written = true;
	report.commentsDropped = stripJsonComments(stripBom(content)) !== stripBom(content);
	return report;
}
