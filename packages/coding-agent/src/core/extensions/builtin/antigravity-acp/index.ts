import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../../config.ts";
import type {
	ExtensionAPI,
	ExtensionContext,
	ProviderConfig,
	ToolResultEvent,
	ToolResultEventResult,
} from "../../types.ts";
import { createAntigravityAuthConfig } from "./auth.ts";
import { createAgyAuthStatusReader, lastProbedModels, probeAgyAuthStatus, probeAgyModels } from "./availability.ts";
import { stopBridgeServer } from "./bridge-server.ts";
import {
	ANTIGRAVITY_ACP_API_ID,
	ANTIGRAVITY_ACP_NAME,
	ANTIGRAVITY_ACP_PROVIDER_ID,
	BRIDGE_TOOL_PREFIX,
	SENTINEL_API_KEY,
} from "./constants.ts";
import { agyChildEnvironment } from "./environment.ts";
import { resolveAgyExecutable } from "./executable.ts";
import {
	parseAgyModels,
	readCachedAgyModels,
	readCachedAgyModelsSync,
	rememberCatalogEntries,
	STATIC_AGY_MODELS,
	toProviderModels,
	writeCachedAgyModels,
} from "./models.ts";
import { closeAllSessions, closeSession, type SeedBindingInput, seedBinding } from "./session.ts";
import {
	type AntigravityAcpSettings,
	DEFAULT_ANTIGRAVITY_AUTH_METHOD,
	loadAntigravityAcpSettingsFromDisk,
} from "./settings.ts";
import { createAntigravityStream } from "./stream.ts";

const BINDING_ENTRY_TYPE = "antigravity-acp-binding";
const TOOL_SEARCH_INACTIVE_BANNER = "Nothing was activated; call one by name and it activates on that first call:";
const MAX_GROUP_SIBLINGS_PER_SEARCH = 32;

type SearchTool = Pick<
	ReturnType<ExtensionAPI["getAllTools"]>[number],
	"name" | "exposure" | "allowLazyActivation" | "searchGroup"
>;
type SearchToolHost = { getAllTools(): readonly SearchTool[] };

type StoredBindingEntry = SeedBindingInput & {
	readonly schemaVersion: 1;
};

/**
 * Make matches visible to ACP without activating them in Senpi. The actual
 * assistant call must go through Senpi's lazy activator; the owning MCP catalog
 * records that promotion and retains it when a cold connection refreshes.
 */
export function collectToolSearchMatchesForAntigravity(
	pi: SearchToolHost,
	event: Pick<ToolResultEvent, "toolName" | "isError" | "details" | "content">,
	ctx: Pick<ExtensionContext, "model">,
	discovered: Set<string>,
): ToolResultEventResult | undefined {
	if (event.toolName !== "tool_search" || event.isError || ctx.model?.provider !== ANTIGRAVITY_ACP_PROVIDER_ID) {
		return undefined;
	}
	if (!isRecord(event.details) || !Array.isArray(event.details.matched)) return undefined;
	const matched = event.details.matched.filter((name): name is string => typeof name === "string" && name.length > 0);
	if (matched.length === 0) return undefined;

	const eligibleTools = pi.getAllTools().filter(isBridgeDiscoverable);
	const eligible = new Set(eligibleTools.map((tool) => tool.name));
	const offered = new Set(matched.filter((name) => eligible.has(name)));
	for (const name of offered) discovered.add(name);

	const matchedGroups = new Set<string>();
	for (const tool of eligibleTools) {
		if (!offered.has(tool.name)) continue;
		for (const key of toolGroupKeys(tool)) matchedGroups.add(key);
	}
	const newSiblings: string[] = [];
	if (matchedGroups.size > 0) {
		for (const tool of eligibleTools) {
			if (offered.has(tool.name)) continue;
			if (!toolGroupKeys(tool).some((key) => matchedGroups.has(key))) continue;
			const wasKnown = discovered.has(tool.name);
			discovered.add(tool.name);
			if (!wasKnown) newSiblings.push(tool.name);
			if (newSiblings.length >= MAX_GROUP_SIBLINGS_PER_SEARCH) break;
		}
	}

	const content = event.content.map((block) => {
		if (block.type !== "text") return block;
		const lines: string[] = [];
		let omitParameters = false;
		for (const line of block.text.split("\n")) {
			const name = /^- (\S+) (?:—|-)\s/.exec(line)?.[1];
			if (name !== undefined && matched.includes(name)) {
				omitParameters = !offered.has(name);
				if (!omitParameters) lines.push(`- ${BRIDGE_TOOL_PREFIX}${line.slice(2)}`);
			} else if (!omitParameters || !line.startsWith("  parameters: ")) {
				omitParameters = false;
				lines.push(
					line.replace(
						TOOL_SEARCH_INACTIVE_BANNER,
						offered.size === 0
							? "None of these matches is available through the senpi-host MCP bridge."
							: "Call the tools listed below through the senpi-host MCP bridge using the exact names shown:",
					),
				);
			}
		}
		if (newSiblings.length > 0) {
			lines.push(
				"",
				`Also ready on the senpi-host MCP bridge from the same group (no extra tool_search needed): ${newSiblings.map((name) => `${BRIDGE_TOOL_PREFIX}${name}`).join(", ")}`,
			);
		}
		return { ...block, text: lines.join("\n") };
	});
	return { content };
}

function toolGroupKeys(tool: SearchTool): string[] {
	const keys: string[] = [];
	if (typeof tool.searchGroup === "string" && tool.searchGroup.length > 0) {
		keys.push(`group:${tool.searchGroup}`);
	}
	if (tool.name.startsWith("mcp_")) {
		const match = /^mcp_([^_]+)_/.exec(tool.name);
		if (match?.[1]) keys.push(`mcp:${match[1]}`);
	}
	return keys;
}

function isBridgeDiscoverable(tool: SearchTool): boolean {
	return tool.allowLazyActivation && (tool.exposure === "direct" || tool.exposure === "search");
}

function readStoredCredential(agentDir: string): OAuthCredential | undefined {
	const authPath = join(agentDir, "auth.json");
	if (!existsSync(authPath)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		const entry = raw[ANTIGRAVITY_ACP_PROVIDER_ID];
		if (isRecord(entry) && entry.type === "oauth") return entry as unknown as OAuthCredential;
		return undefined;
	} catch {
		return undefined;
	}
}

export default function antigravityAcpExtension(pi: ExtensionAPI): void {
	let currentCwd = process.cwd();
	const discoveredBySession = new Map<string, Set<string>>();
	const agentDir = getAgentDir();
	const cachePath = join(agentDir, "antigravity-acp", "models.json");
	const availabilityCachePath = join(agentDir, "antigravity-acp", "availability.json");
	const loadSettings = (cwd = currentCwd): AntigravityAcpSettings => loadAntigravityAcpSettingsFromDisk(cwd, agentDir);
	const resolveExecutable = (settings: AntigravityAcpSettings): string => resolveAgyExecutable(settings);
	const readCredential = async (): Promise<OAuthCredential | undefined> => readStoredCredential(agentDir);
	const readAuthStatus = createAgyAuthStatusReader((options) =>
		probeAgyAuthStatus({
			settings: loadSettings(),
			cachePath: availabilityCachePath,
			force: options?.force,
		}),
	);

	const initialEntries = readCachedAgyModelsSync(cachePath, Date.now()) ?? STATIC_AGY_MODELS;
	rememberCatalogEntries(initialEntries);

	const streamSimple = createAntigravityStream({
		getCwd: () => currentCwd,
		resolveExecutable,
		loadSettings,
		agentDir,
		discoveredTools: (key) => {
			const names = discoveredBySession.get(key);
			return names === undefined
				? []
				: pi.getAllTools().filter((tool) => names.has(tool.name) && isBridgeDiscoverable(tool));
		},
		onBinding: (_key, binding) => {
			pi.appendEntry(BINDING_ENTRY_TYPE, {
				schemaVersion: 1,
				...binding,
			} satisfies StoredBindingEntry);
		},
	});

	const config: ProviderConfig = {
		name: ANTIGRAVITY_ACP_NAME,
		baseUrl: ANTIGRAVITY_ACP_API_ID,
		api: ANTIGRAVITY_ACP_API_ID,
		localOnly: true,
		models: toProviderModels(initialEntries),
		streamSimple,
		refreshModels: async (context) => {
			const now = Date.now();
			const cached = await readCachedAgyModels(cachePath, now);
			if (cached !== undefined && cached.length > 0) {
				rememberCatalogEntries(cached);
				return toProviderModels(cached);
			}
			const settings = loadSettings();
			if (context.signal.aborted || settings.enabled === false) {
				return toProviderModels(STATIC_AGY_MODELS);
			}

			const remembered = lastProbedModels();
			if (remembered !== undefined && remembered.length > 0) {
				rememberCatalogEntries(remembered);
				await cacheModels(cachePath, remembered, now);
				return toProviderModels(remembered);
			}
			try {
				const executable = resolveExecutable(settings);
				const result = await probeAgyModels({
					executable,
					env: agyChildEnvironment(process.env, {
						authMethod: settings.authMethod ?? DEFAULT_ANTIGRAVITY_AUTH_METHOD,
					}),
				});
				if (!result.ok || context.signal.aborted) return toProviderModels(STATIC_AGY_MODELS);
				const entries = parseAgyModels(result.stdout);
				if (entries.length === 0) return toProviderModels(STATIC_AGY_MODELS);
				rememberCatalogEntries(entries);
				await cacheModels(cachePath, entries, now);
				return toProviderModels(entries);
			} catch {
				return toProviderModels(STATIC_AGY_MODELS);
			}
		},
		fallbackEligible: () => {
			try {
				const settings = loadSettings();
				if (settings.enabled === false) return false;
				return settings.enabled === true || readStoredCredential(agentDir)?.access === SENTINEL_API_KEY;
			} catch {
				return false;
			}
		},
		oauth: createAntigravityAuthConfig({
			readSettings: () => loadSettings(),
			readAuthStatus,
			resolveExecutable,
			readStoredCredential: readCredential,
		}),
	};

	pi.registerProvider(ANTIGRAVITY_ACP_PROVIDER_ID, config);

	pi.on("session_start", (event, ctx) => {
		if (ctx.cwd) currentCwd = ctx.cwd;
		const sessionId = ctx.sessionManager.getSessionId();
		if (event.reason === "new" || event.reason === "fork") {
			discoveredBySession.delete(sessionId);
			return;
		}
		const binding = newestBinding(ctx.sessionManager.getBranch());
		if (binding !== undefined) seedBinding(sessionId, binding);
		else discoveredBySession.delete(sessionId);
	});
	pi.on("model_select", (event, ctx) => {
		if (event.model.provider === ANTIGRAVITY_ACP_PROVIDER_ID) return;
		closeSession(ctx.sessionManager.getSessionId(), "model_selected", { keepConversation: true });
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "tool_search" || ctx.model?.provider !== ANTIGRAVITY_ACP_PROVIDER_ID) return;
		const key = ctx.sessionManager.getSessionId();
		let discovered = discoveredBySession.get(key);
		if (discovered === undefined) {
			discovered = new Set<string>();
			discoveredBySession.set(key, discovered);
		}
		return collectToolSearchMatchesForAntigravity(pi, event, ctx, discovered);
	});
	pi.on("session_shutdown", async () => {
		discoveredBySession.clear();
		await closeAllSessions();
		await stopBridgeServer();
	});
}

async function cacheModels(path: string, entries: Parameters<typeof toProviderModels>[0], now: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeCachedAgyModels(path, entries, now);
}

function newestBinding(branch: readonly unknown[]): StoredBindingEntry | undefined {
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index];
		if (!isRecord(entry)) continue;
		// Stop at compaction boundaries so pre-compaction conversations are never reattached.
		if (entry.type === "compaction") return undefined;
		if (entry.type !== "custom" || entry.customType !== BINDING_ENTRY_TYPE) continue;
		return parseBinding(entry.data);
	}
	return undefined;
}

function parseBinding(value: unknown): StoredBindingEntry | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
	if (
		typeof value.conversationId !== "string" ||
		typeof value.syncedCount !== "number" ||
		!Number.isInteger(value.syncedCount) ||
		value.syncedCount < 0 ||
		typeof value.prefixDigest !== "string" ||
		typeof value.modelId !== "string"
	) {
		return undefined;
	}
	return {
		schemaVersion: 1,
		conversationId: value.conversationId,
		syncedCount: value.syncedCount,
		prefixDigest: value.prefixDigest,
		modelId: value.modelId,
		...(typeof value.lastAssistantDigest === "string" ? { lastAssistantDigest: value.lastAssistantDigest } : {}),
		...(typeof value.lastInputDigest === "string" ? { lastInputDigest: value.lastInputDigest } : {}),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
