import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../../../../config.ts";
import type { McpServerConfig } from "./config-schema.ts";
import type { ServerConnection } from "./connection.ts";
import { collectAllPages } from "./expose/pagination.ts";

type ListedTool = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type ListedResource = Awaited<ReturnType<Client["listResources"]>>["resources"][number];
type ListedResourceTemplate = Awaited<ReturnType<Client["listResourceTemplates"]>>["resourceTemplates"][number];
type ListedPrompt = Awaited<ReturnType<Client["listPrompts"]>>["prompts"][number];

export interface McpCatalogCacheFile {
	readonly version: 1;
	readonly servers: Record<string, McpCachedServerCatalog>;
}

export interface McpCachedServerCatalog {
	readonly configHash: string;
	readonly credentialIdentity?: string;
	readonly fetchedAt: number;
	readonly tools: ListedTool[];
	readonly resources: ListedResource[];
	readonly resourceTemplates?: ListedResourceTemplate[];
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
		const parsed: unknown = JSON.parse(await readFile(getMcpCatalogCachePath(agentDir), "utf8"));
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
	credentialIdentity = "none",
): McpCachedServerCatalog | undefined {
	const cached = cache.servers[serverName];
	if (cached === undefined) return undefined;
	if (cached.configHash !== configHash) return undefined;
	if (
		cached.credentialIdentity !== credentialIdentity &&
		!(credentialIdentity === "none" && cached.credentialIdentity === undefined)
	) {
		return undefined;
	}
	if (now - cached.fetchedAt > CACHE_TTL_MS) return undefined;
	return cached;
}

export async function collectServerCatalogForCache(
	connection: ServerConnection,
	config: McpServerConfig,
	configHash: string,
	credentialIdentity?: string,
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
	const resourceTemplates = await collectOptionalPages<ListedResourceTemplate>((cursor) =>
		connection.client.listResourceTemplates(cursor === undefined ? {} : { cursor }, {
			timeout: config.requestTimeoutMs,
		}),
	);
	return {
		configHash,
		credentialIdentity,
		fetchedAt: Date.now(),
		instructions: connection.client.getInstructions(),
		prompts,
		resources,
		resourceTemplates,
		tools: tools.items,
	};
}

export async function writeMcpCachedServer(
	agentDir: string | undefined,
	serverName: string,
	server: McpCachedServerCatalog,
	isCurrent?: () => boolean,
): Promise<void> {
	if (isCurrent?.() === false) return;
	const path = getMcpCatalogCachePath(agentDir);
	await mkdir(dirname(path), { recursive: true });
	const release = await lockfile.lock(dirname(path), {
		lockfilePath: `${path}.lock`,
		realpath: false,
		retries: { retries: 50, factor: 1.2, minTimeout: 20, maxTimeout: 200 },
		stale: 30_000,
	});
	try {
		if (isCurrent?.() === false) return;
		const cache = await readMcpCatalogCache(agentDir);
		if (isCurrent?.() === false) return;
		const next: McpCatalogCacheFile = { version: 1, servers: { ...cache.servers, [serverName]: server } };
		await atomicWriteJson(path, next, isCurrent);
	} finally {
		await release();
	}
}

async function collectOptionalPages<TItem>(listFn: (cursor: string | undefined) => Promise<unknown>): Promise<TItem[]> {
	try {
		const result = await collectAllPages<TItem>((cursor) => listFn(cursor) as Promise<{ items?: TItem[] }>);
		return result.items;
	} catch {
		return [];
	}
}

async function atomicWriteJson(path: string, value: unknown, isCurrent?: () => boolean): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		if (isCurrent?.() === false) return;
		await rename(tmp, path);
	} finally {
		await rm(tmp, { force: true });
	}
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
	const resourceTemplates = Array.isArray(value.resourceTemplates)
		? (value.resourceTemplates as ListedResourceTemplate[])
		: [];
	const instructions = typeof value.instructions === "string" ? value.instructions : undefined;
	return {
		configHash: value.configHash,
		credentialIdentity: typeof value.credentialIdentity === "string" ? value.credentialIdentity : undefined,
		fetchedAt: value.fetchedAt,
		instructions,
		prompts,
		resources,
		resourceTemplates,
		tools,
	};
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
