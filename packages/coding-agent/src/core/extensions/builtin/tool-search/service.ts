import { AsyncLocalStorage } from "node:async_hooks";
import { basename, extname } from "node:path";
import { extensionLoadKey } from "../../extension-load-key.ts";
import type { ExtensionAPI, ToolInfo } from "../../types.ts";
import {
	type Bm25Result,
	type Bm25SearchOptions,
	buildBm25Index,
	DEFAULT_BM25_PRECISION,
	normalizeToolName,
	tokenizeToolText,
} from "./engine/bm25.ts";
import type { ToolSearchDocument, ToolSearchSource } from "./engine/document.ts";
import { deriveExtensionRegistrationId, rehydrate } from "./engine/marker.ts";
import { TOOL_SEARCH_TOOL_NAME } from "./tool.ts";

export interface ToolSearchFeederHooks {
	/** Activate every named match, including names already active as stubs. */
	activate(names: readonly string[]): void;
}

export interface ToolSearchRuntime {
	getAllTools(): ToolInfo[];
	getActiveTools(): string[];
	setActiveTools(names: readonly string[]): void;
}

type RuntimeApi = Pick<ExtensionAPI, "getActiveTools" | "getAllTools" | "setActiveTools">;

/** Redirect text for a tool the model may name but cannot call directly (eval-only bash, removed tools). */
export interface HiddenToolHint {
	readonly name: string;
	readonly hint: string;
}

interface FeedState {
	docs: ToolSearchDocument[];
	hooks: ToolSearchFeederHooks;
}

/** Session-scoped owner of the live generalized tool-search catalog. */
export class ToolSearchService {
	#runtime: ToolSearchRuntime;
	readonly #feeds = new Map<ToolSearchSource, FeedState>();
	#extensionDocs: ToolSearchDocument[] = [];
	#extensionFingerprint = "";
	#registryGeneration = 0;
	#historyScannedGeneration = -1;
	#registerToolSearch: (() => void) | undefined;
	#removedToolHints: () => Readonly<Record<string, string>> = () => ({});
	#disposed: { sessionId: string; reason: string } | undefined;

	constructor(runtime: ToolSearchRuntime) {
		this.#runtime = runtime;
		this.#feeds.set("extension", {
			docs: [],
			hooks: { activate: (names) => this.#promoteExtensionTools(names) },
		});
	}

	#nativeInjectionFailure: string | null = null;

	get isDisposed(): boolean {
		return this.#disposed !== undefined;
	}

	/** Retire this service with its session or extension generation; every later use throws. */
	dispose(sessionId: string, reason: string): void {
		this.#disposed ??= { sessionId, reason };
		sessionServices.delete(this);
	}

	#assertLive(): void {
		if (this.#disposed === undefined) return;
		const { sessionId, reason } = this.#disposed;
		throw new Error(
			`The tool-search service of session ${sessionId} is disposed (${reason}). Resolve the live session's own tool-search service instead of a retained one.`,
		);
	}

	/** Record that a native-injected request was rejected; the session consumes it once. */
	noteNativeInjectionFailure(reason: string): void {
		this.#assertLive();
		this.#nativeInjectionFailure = reason;
	}

	/** Consume the pending native-injection failure, if any (one-shot). */
	takeNativeInjectionFailure(): string | null {
		this.#assertLive();
		const reason = this.#nativeInjectionFailure;
		this.#nativeInjectionFailure = null;
		return reason;
	}

	bindRuntime(runtime: RuntimeApi): void {
		this.#runtime = runtime;
	}

	bindActivationRuntime(runtime: Pick<RuntimeApi, "getActiveTools" | "setActiveTools">): void {
		this.#runtime = { ...this.#runtime, ...runtime };
	}

	/** Register the resident search tool only after a searchable catalog exists. */
	bindToolRegistrar(register: () => void): void {
		this.#registerToolSearch = register;
	}

	/** Let the host expose its removed-tool hints so a search for a hidden tool answers with the redirect. */
	bindRemovedToolHints(provider: () => Readonly<Record<string, string>>): void {
		this.#removedToolHints = provider;
	}

	/** Hints for every hidden tool the query names, in query order. */
	hiddenToolHints(query: string): HiddenToolHint[] {
		this.#assertLive();
		const hints = this.#removedToolHints();
		const byNormalizedName = new Map(
			Object.entries(hints).map(([name, hint]) => [normalizeToolName(name), { hint, name }]),
		);
		if (byNormalizedName.size === 0) return [];
		const seen = new Set<string>();
		const matched: HiddenToolHint[] = [];
		for (const candidate of [normalizeToolName(query), ...tokenizeToolText(query)]) {
			const entry = byNormalizedName.get(candidate);
			if (entry === undefined || seen.has(entry.name)) continue;
			seen.add(entry.name);
			matched.push(entry);
		}
		return matched;
	}

	/** Parameter schema of a registered tool, active or not, so a search result can be called by name. */
	getToolParameters(name: string): unknown {
		this.#assertLive();
		return this.#runtime.getAllTools().find((tool) => tool.name === name)?.parameters;
	}

	beginSession(): void {
		this.#assertLive();
		this.#feeds.delete("mcp");
		this.#registryGeneration += 1;
		this.#historyScannedGeneration = -1;
		this.#refreshExtensionDocs();
		this.#syncToolSearchLifecycle();
	}

	/** Replace one source's catalog generation and activation hook. */
	feed(source: "mcp", docs: readonly ToolSearchDocument[], hooks: ToolSearchFeederHooks): void {
		this.#assertLive();
		const validDocs = docs.filter((doc) => isValidDocument(doc, source));
		this.#feeds.set(source, { docs: validDocs, hooks });
		this.#registryGeneration += 1;
		this.#syncToolSearchLifecycle();
	}

	getCatalog(): ToolSearchDocument[] {
		this.#assertLive();
		this.#refreshExtensionDocs();
		return [...(this.#feeds.get("mcp")?.docs ?? []), ...this.#extensionDocs];
	}

	search(query: string, limit = 10, options: Bm25SearchOptions = {}): Bm25Result[] {
		return buildBm25Index(this.getCatalog()).search(query, limit, { precision: DEFAULT_BM25_PRECISION, ...options });
	}

	/** Route all matches through their owning feeder, even when already active. */
	activate(matches: readonly Bm25Result[]): string[] {
		this.#assertLive();
		const namesBySource = new Map<ToolSearchSource, string[]>();
		for (const match of matches) {
			const names = namesBySource.get(match.doc.source) ?? [];
			names.push(match.name);
			namesBySource.set(match.doc.source, names);
		}
		for (const [source, names] of namesBySource) {
			this.#feeds.get(source)?.hooks.activate(names);
		}
		const active = new Set(this.#runtime.getActiveTools());
		return matches.map(({ name }) => name).filter((name) => active.has(name));
	}

	activateTool(name: string): boolean {
		const doc = this.getCatalog().find((candidate) => candidate.name === name);
		if (doc === undefined) return false;
		this.#feeds.get(doc.source)?.hooks.activate([name]);
		return this.#runtime.getActiveTools().includes(name);
	}

	/** Replay ownership-aware and legacy MCP history once per catalog generation. */
	maybeRehydrateFromHistory(messages: readonly unknown[]): string[] {
		const catalog = this.getCatalog();
		if (this.#historyScannedGeneration === this.#registryGeneration) return [];
		this.#historyScannedGeneration = this.#registryGeneration;
		const docsByName = new Map(
			catalog.map((doc) => [
				doc.name,
				{
					name: doc.name,
					registrationId: doc.registrationId,
					source: doc.source,
					allowLazyActivation: true,
				},
			]),
		);
		const restored = rehydrate(messages, docsByName);
		if (restored.length > 0) this.#activateNames(restored, catalog);
		return restored;
	}

	#refreshExtensionDocs(): void {
		const docs = this.#runtime
			.getAllTools()
			.filter((tool) => tool.exposure === "search" && tool.allowLazyActivation)
			.map(extensionDocument)
			.filter((doc): doc is ToolSearchDocument => doc !== undefined)
			.sort((left, right) => left.name.localeCompare(right.name));
		const fingerprint = JSON.stringify(docs);
		if (fingerprint === this.#extensionFingerprint) return;
		this.#extensionDocs = docs;
		this.#extensionFingerprint = fingerprint;
		this.#feeds.set("extension", {
			docs,
			hooks: { activate: (names) => this.#promoteExtensionTools(names) },
		});
		this.#registryGeneration += 1;
		this.#syncToolSearchLifecycle();
	}

	#activateNames(names: readonly string[], catalog = this.getCatalog()): void {
		const sourceByName = new Map(catalog.map((doc) => [doc.name, doc.source] as const));
		const namesBySource = new Map<ToolSearchSource, string[]>();
		for (const name of names) {
			const source = sourceByName.get(name);
			if (source === undefined) continue;
			const sourceNames = namesBySource.get(source) ?? [];
			sourceNames.push(name);
			namesBySource.set(source, sourceNames);
		}
		for (const [source, sourceNames] of namesBySource) this.#feeds.get(source)?.hooks.activate(sourceNames);
	}

	#syncToolSearchLifecycle(): void {
		const hasDocuments = this.#extensionDocs.length > 0 || (this.#feeds.get("mcp")?.docs.length ?? 0) > 0;
		if (hasDocuments) this.#registerToolSearch?.();
		const current = this.#runtime.getActiveTools();
		const isActive = current.includes(TOOL_SEARCH_TOOL_NAME);
		if (hasDocuments === isActive) return;
		this.#runtime.setActiveTools(
			hasDocuments ? [...current, TOOL_SEARCH_TOOL_NAME] : current.filter((name) => name !== TOOL_SEARCH_TOOL_NAME),
		);
	}

	#promoteExtensionTools(names: readonly string[]): void {
		if (names.length === 0) return;
		const current = this.#runtime.getActiveTools();
		const active = new Set(current);
		const added = [...new Set(names.filter((name) => !active.has(name)))].sort();
		this.#runtime.setActiveTools([...current, ...added]);
	}
}

function extensionDocument(tool: ToolInfo): ToolSearchDocument | undefined {
	if (tool.name.length === 0) return undefined;
	const ownerLabel = extensionOwnerLabel(tool);
	const registrationId = deriveExtensionRegistrationId(tool.sourceInfo, tool.name);
	if (registrationId.length === 0) return undefined;
	return {
		name: tool.name,
		label: tool.label,
		aliases: [],
		description: tool.description,
		searchText: tool.searchText,
		keywords: tool.searchKeywords,
		source: "extension",
		group: tool.searchGroup ?? ownerLabel,
		ownerLabel,
		registrationId,
	};
}

function extensionOwnerLabel(tool: ToolInfo): string {
	const fileName = basename(tool.sourceInfo.path);
	const extension = extname(fileName);
	return extension.length === 0 ? fileName : fileName.slice(0, -extension.length);
}

function isValidDocument(doc: ToolSearchDocument, source: ToolSearchSource): boolean {
	return doc.source === source && doc.name.length > 0 && doc.registrationId.length > 0;
}

const scopedService = new AsyncLocalStorage<ToolSearchService>();
let servicesByExtensionLoad = new WeakMap<object, ToolSearchService>();
const sessionServices = new Set<ToolSearchService>();
let sessionlessService: ToolSearchService | null = null;

/** Make a session-owned service visible to later builtins loaded in the same provider scope. */
export function installScopedToolSearchService(value: ToolSearchService): void {
	scopedService.enterWith(value);
}

/** Own `value` as the tool-search service of the extension load that created `pi`. */
export function registerToolSearchServiceForExtensionLoad(pi: ExtensionAPI, value: ToolSearchService): void {
	const load = extensionLoadKey(pi);
	if (load !== undefined) servicesByExtensionLoad.set(load, value);
}

/** The tool-search service owned by the extension load that created `pi`. */
export function getToolSearchServiceForExtension(pi: object): ToolSearchService | undefined {
	const load = extensionLoadKey(pi);
	return load === undefined ? undefined : servicesByExtensionLoad.get(load);
}

/** A session takes the service its extension load (keyed by that load's runtime) created. */
export function adoptToolSearchServiceForSession(extensionLoad: object): ToolSearchService | undefined {
	const value = servicesByExtensionLoad.get(extensionLoad);
	if (value !== undefined) sessionServices.add(value);
	return value;
}

/**
 * Resolve a service for a caller that holds no session: the provider scope's service, else the
 * only live session's service. With several live sessions there is no right answer, so it throws.
 * With none, a standalone service serves session-free callers.
 */
export function getToolSearchService(runtime?: ToolSearchRuntime): ToolSearchService {
	const scoped = scopedService.getStore();
	if (scoped !== undefined) {
		if (runtime !== undefined) scoped.bindRuntime(runtime);
		return scoped;
	}
	if (sessionServices.size === 1) return [...sessionServices][0];
	if (sessionServices.size > 1) {
		throw new Error(
			`getToolSearchService() cannot choose between ${sessionServices.size} live sessions; resolve the service through the session that owns it`,
		);
	}
	if (sessionlessService === null) {
		if (runtime === undefined) throw new Error("ToolSearchService runtime is not bound");
		sessionlessService = new ToolSearchService(runtime);
	} else if (runtime !== undefined) {
		sessionlessService.bindRuntime(runtime);
	}
	return sessionlessService;
}

export function resetToolSearchServiceForTests(): void {
	sessionlessService = null;
	sessionServices.clear();
	servicesByExtensionLoad = new WeakMap();
}
