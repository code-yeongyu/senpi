import type { Api, Model as PiModel } from "@earendil-works/pi-ai";
import { getAgentDir } from "../../../config.ts";
import { AuthStorage } from "../../../core/auth-storage.ts";
import { ModelRegistry } from "../../../core/model-registry.ts";
import { defaultModelPerProvider } from "../../../core/model-resolver.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { resolvePath } from "../../../utils/paths.ts";
import { buildSenpiCollaborationModePreset } from "../protocol/collaboration-mode.ts";
import type {
	CollaborationModeListResponse,
	ExperimentalFeature,
	ExperimentalFeatureListParams,
	McpServerStatus,
	McpServerStatusDetail,
	McpServerStatusListParams,
	McpServerStatusListResponse,
	PermissionProfileListParams,
	PermissionProfileSummary,
} from "../protocol/index.ts";
import { RpcHandlerError } from "../rpc/errors.ts";
import type { MethodRegistry } from "../rpc/registry.ts";
import type { ThreadRegistry } from "../threads/registry.ts";
import type { AppServerModelRegistry } from "./models.ts";

export interface RegisterAppServerCatalogMethodsOptions {
	readonly modelRegistry?: AppServerModelRegistry;
	readonly agentDir?: string;
	readonly serverCwd?: string;
	readonly threads?: Pick<ThreadRegistry, "getLoadedThread" | "getMcpWireStatusAdapter">;
}

const PERMISSION_PROFILES = [
	{ id: "dangerFullAccess", description: null, allowed: true },
] as const satisfies readonly PermissionProfileSummary[];

const EXPERIMENTAL_FEATURES = [] as const satisfies readonly ExperimentalFeature[];

export function registerAppServerCatalogMethods(
	registry: MethodRegistry,
	options: RegisterAppServerCatalogMethodsOptions = {},
): void {
	const serverCwd = resolvePath(options.serverCwd ?? process.cwd());
	const agentDir = options.agentDir ?? getAgentDir();
	let defaultModelRegistry: AppServerModelRegistry | undefined;
	const getModelRegistry = (): AppServerModelRegistry => {
		defaultModelRegistry ??= ModelRegistry.create(AuthStorage.create());
		return options.modelRegistry ?? defaultModelRegistry;
	};

	registry.register("collaborationMode/list", {
		experimental: true,
		scope: "global",
		handler: ({ request }) => {
			parseObjectParams(request.params, "collaborationMode/list");
			const model = defaultModelId(getModelRegistry().getAvailable());
			return { data: [buildSenpiCollaborationModePreset(model)] } satisfies CollaborationModeListResponse;
		},
	});

	registry.register("permissionProfile/list", {
		scope: "global",
		handler: ({ request }) => {
			const params = parsePermissionProfileListParams(request.params);
			const cwd = resolvePath(params.cwd ?? serverCwd, serverCwd, { trim: true });
			SettingsManager.create(cwd, agentDir).getProjectSettings();
			return paginateCatalog(PERMISSION_PROFILES, params.cursor, params.limit, "permissionProfile/list");
		},
	});

	registry.register("experimentalFeature/list", {
		scope: "global",
		handler: ({ request }) => {
			const params = parseExperimentalFeatureListParams(request.params);
			validateThreadId(params.threadId, options.threads, "experimentalFeature/list");
			return paginateCatalog(EXPERIMENTAL_FEATURES, params.cursor, params.limit, "experimentalFeature/list");
		},
	});

	registry.register("mcpServerStatus/list", {
		scope: "global",
		handler: ({ request }) => {
			const params = parseMcpServerStatusListParams(request.params);
			validateThreadId(params.threadId, options.threads, "mcpServerStatus/list");
			const adapter = options.threads?.getMcpWireStatusAdapter(params.threadId);
			const detail = params.detail ?? "full";
			const statuses = adapter?.getServerStatuses() ?? [];
			const visibleStatuses = statuses.map((status) => applyMcpServerStatusDetail(status, detail));
			return paginateCatalog(
				visibleStatuses,
				params.cursor,
				params.limit,
				"mcpServerStatus/list",
			) satisfies McpServerStatusListResponse;
		},
	});
}

function defaultModelId(models: readonly PiModel<Api>[]): string {
	const knownDefault = models.find((model) =>
		Object.entries(defaultModelPerProvider).some(
			([provider, modelId]) => provider === model.provider && modelId === model.id,
		),
	);
	return knownDefault?.id ?? models[0]?.id ?? "unknown";
}

function parsePermissionProfileListParams(value: unknown): PermissionProfileListParams {
	const params = parseObjectParams(value, "permissionProfile/list");
	return {
		cursor: optionalString(params.cursor, "permissionProfile/list", "cursor"),
		limit: optionalNumber(params.limit, "permissionProfile/list", "limit"),
		cwd: optionalString(params.cwd, "permissionProfile/list", "cwd"),
	};
}

function parseExperimentalFeatureListParams(value: unknown): ExperimentalFeatureListParams {
	const params = parseObjectParams(value, "experimentalFeature/list");
	return {
		cursor: optionalString(params.cursor, "experimentalFeature/list", "cursor"),
		limit: optionalNumber(params.limit, "experimentalFeature/list", "limit"),
		threadId: optionalString(params.threadId, "experimentalFeature/list", "threadId"),
	};
}

function parseMcpServerStatusListParams(value: unknown): McpServerStatusListParams {
	const params = parseObjectParams(value, "mcpServerStatus/list");
	return {
		cursor: optionalString(params.cursor, "mcpServerStatus/list", "cursor"),
		limit: optionalNumber(params.limit, "mcpServerStatus/list", "limit"),
		detail: optionalMcpServerStatusDetail(params.detail),
		threadId: optionalString(params.threadId, "mcpServerStatus/list", "threadId"),
	};
}

function optionalMcpServerStatusDetail(value: unknown): McpServerStatusDetail | null | undefined {
	if (value === undefined || value === null) return value;
	if (value === "full" || value === "toolsAndAuthOnly") return value;
	throw invalidCatalogParams("mcpServerStatus/list detail must be full, toolsAndAuthOnly, or null");
}

function applyMcpServerStatusDetail(server: McpServerStatus, detail: McpServerStatusDetail): McpServerStatus {
	switch (detail) {
		case "full":
			return server;
		case "toolsAndAuthOnly":
			return {
				...server,
				serverInfo: null,
				resources: [],
				resourceTemplates: [],
			};
		default:
			return assertNever(detail);
	}
}

function parseObjectParams(value: unknown, method: string): Record<string, unknown> {
	if (value === undefined || value === null) return {};
	if (!isRecord(value)) throw invalidCatalogParams(`${method} params must be an object`);
	return value;
}

function optionalString(value: unknown, method: string, field: string): string | null | undefined {
	if (value === undefined || value === null) return value;
	if (typeof value !== "string") throw invalidCatalogParams(`${method} ${field} must be a string or null`);
	return value;
}

function optionalNumber(value: unknown, method: string, field: string): number | null | undefined {
	if (value === undefined || value === null) return value;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw invalidCatalogParams(`${method} ${field} must be a non-negative integer or null`);
	}
	return value;
}

function paginateCatalog<T>(
	items: readonly T[],
	cursor: string | null | undefined,
	limit: number | null | undefined,
	method: string,
): { readonly data: readonly T[]; readonly nextCursor: string | null } {
	const start = parseCursor(cursor, items.length, method);
	const pageSize = Math.max(1, limit ?? items.length);
	const data = items.slice(start, start + pageSize);
	const nextOffset = start + data.length;
	return { data, nextCursor: nextOffset < items.length ? String(nextOffset) : null };
}

function parseCursor(cursor: string | null | undefined, total: number, method: string): number {
	if (cursor === undefined || cursor === null) return 0;
	if (!/^\d+$/u.test(cursor)) throw invalidCatalogParams(`${method} received an invalid cursor: ${cursor}`);
	const offset = Number(cursor);
	if (!Number.isSafeInteger(offset) || offset > total) {
		throw invalidCatalogParams(`${method} cursor ${cursor} exceeds total records ${total}`);
	}
	return offset;
}

function validateThreadId(
	threadId: string | null | undefined,
	threads: Pick<ThreadRegistry, "getLoadedThread"> | undefined,
	method: string,
): void {
	if (threadId === undefined || threadId === null) return;
	if (!threads) throw invalidCatalogParams(`${method} received an unknown threadId: ${threadId}`);
	try {
		threads.getLoadedThread(threadId);
	} catch (error: unknown) {
		if (error instanceof Error && error.name === "ThreadNotFoundError") {
			throw invalidCatalogParams(`${method} received an unknown threadId: ${threadId}`);
		}
		throw error;
	}
}

function invalidCatalogParams(message: string): RpcHandlerError {
	return new RpcHandlerError({ code: -32600, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
	throw new Error(`Unhandled MCP server status detail: ${JSON.stringify(value)}`);
}
