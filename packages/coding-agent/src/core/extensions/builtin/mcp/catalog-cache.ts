import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getAgentDir } from "../../../../config.ts";
import type { McpServerConfig } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import { collectAllPages } from "./expose/pagination.ts";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ListedResource = Awaited<ReturnType<Client["listResources"]>>["resources"][number];
type ListedPrompt = Awaited<ReturnType<Client["listPrompts"]>>["prompts"][number];

export interface McpCatalogCacheFile {
	readonly version: 1;
	readonly servers: Record<string, McpCachedServerCatalog>;
}

export interface McpCachedServerCatalog {
	readonly configHash: string;
	readonly fetchedAt: number;
	readonly tools: ListedTool[];
	readonly resources: ListedResource[];
	readonly prompts: ListedPrompt[];
	readonly instructions?: string;
}

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EMPTY_CACHE: McpCatalogCacheFile = { version: 1, servers: {} };

export function getMcpCatalogCachePath(agentDir = getAgentDir()): string {
	return join(agentDir, "cache", "mcp-cache.json");
}

export async function readMcpCatalogCache(agentDir?: string): Promise<McpCatalogCacheFile> {
	try {
		const parsed = JSON.parse(await readFile(getMcpCatalogCachePath(agentDir), "utf8")) as unknown;
		return normalizeCacheFile(parsed);
	} catch {
		return EMPTY_CACHE;
	}
}

export function getValidCachedServer(
	cache: McpCatalogCacheFile,
	serverName: string,
	configHash: string,
	now = Date.now(),
): McpCachedServerCatalog | undefined {
	const cached = cache.servers[serverName];
	if (cached === undefined) return undefined;
	if (cached.configHash !== configHash) return undefined;
	if (now - cached.fetchedAt > CACHE_TTL_MS) return undefined;
	return cached;
}

export async function collectServerCatalogForCache(
	connection: ServerConnection,
	config: McpServerConfig,
	configHash: string,
): Promise<McpCachedServerCatalog> {
	const tools = await collectAllPages<ListedTool>((cursor) =>
		connection.client.listTools(cursor === undefined ? {} : { cursor }, { timeout: config.requestTimeoutMs }),
	);
	const resources = await collectOptionalPages<ListedResource>((cursor) =>
		connection.client.listResources(cursor === undefined ? {} : { cursor }, { timeout: config.requestTimeoutMs }),
	);
	const prompts = await collectOptionalPages<ListedPrompt>((cursor) =>
		connection.client.listPrompts(cursor === undefined ? {} : { cursor }, { timeout: config.requestTimeoutMs }),
	);
	return {
		configHash,
		fetchedAt: Date.now(),
		instructions: connection.client.getInstructions(),
		prompts,
		resources,
		tools: tools.items,
	};
}

export async function writeMcpCachedServer(
	agentDir: string | undefined,
	serverName: string,
	server: McpCachedServerCatalog,
): Promise<void> {
	const cache = await readMcpCatalogCache(agentDir);
	const next: McpCatalogCacheFile = { version: 1, servers: { ...cache.servers, [serverName]: server } };
	await atomicWriteJson(getMcpCatalogCachePath(agentDir), next);
}

async function collectOptionalPages<TItem>(listFn: (cursor: string | undefined) => Promise<unknown>): Promise<TItem[]> {
	try {
		const result = await collectAllPages<TItem>((cursor) => listFn(cursor) as Promise<{ items?: TItem[] }>);
		return result.items;
	} catch {
		return [];
	}
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}

function normalizeCacheFile(value: unknown): McpCatalogCacheFile {
	if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) return EMPTY_CACHE;
	const servers: Record<string, McpCachedServerCatalog> = {};
	for (const [name, server] of Object.entries(value.servers)) {
		const normalized = normalizeCachedServer(server);
		if (normalized !== undefined) servers[name] = normalized;
	}
	return { version: 1, servers };
}

function normalizeCachedServer(value: unknown): McpCachedServerCatalog | undefined {
	if (!isRecord(value) || typeof value.configHash !== "string" || typeof value.fetchedAt !== "number") {
		return undefined;
	}
	const tools = normalizeTools(value.tools);
	if (tools === undefined) return undefined;
	const resources = Array.isArray(value.resources) ? (value.resources as ListedResource[]) : [];
	const prompts = Array.isArray(value.prompts) ? (value.prompts as ListedPrompt[]) : [];
	const instructions = typeof value.instructions === "string" ? value.instructions : undefined;
	return { configHash: value.configHash, fetchedAt: value.fetchedAt, instructions, prompts, resources, tools };
}

function normalizeTools(value: unknown): ListedTool[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tools: ListedTool[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.name !== "string" || !isRecord(item.inputSchema)) return undefined;
		tools.push({
			annotations: isRecord(item.annotations) ? (item.annotations as ListedTool["annotations"]) : undefined,
			description: typeof item.description === "string" ? item.description : undefined,
			inputSchema: item.inputSchema as ListedTool["inputSchema"],
			name: item.name,
		});
	}
	return tools;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
