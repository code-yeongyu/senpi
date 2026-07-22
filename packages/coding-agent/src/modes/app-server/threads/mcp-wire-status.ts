import { resolveAuthMode } from "../../../core/extensions/builtin/mcp/auth/context.ts";
import { loadMcpConfig } from "../../../core/extensions/builtin/mcp/config.ts";
import type { ResolvedMcpServer } from "../../../core/extensions/builtin/mcp/config-schema.ts";
import type {
	McpWireAuthStatus,
	McpWireJsonValue,
	McpWireResource,
	McpWireResourceTemplate,
	McpWireServerInfo,
	McpWireStatusServer,
	McpWireStatusSnapshot,
	McpWireTool,
} from "../../../core/extensions/builtin/mcp/service-types.ts";
import type { JsonValue, McpServerInfo, McpServerStatus, Resource, ResourceTemplate, Tool } from "../protocol/index.ts";

export type { McpWireStatusServer, McpWireStatusSnapshot } from "../../../core/extensions/builtin/mcp/service-types.ts";

/**
 * Session-owned MCP inventory. The snapshot is captured at attach time and is
 * never read from the module-global MCP service during a request.
 */
export class McpWireStatusAdapter {
	#servers: readonly McpServerStatus[];

	constructor(snapshot: McpWireStatusSnapshot) {
		this.#servers = mapSnapshot(snapshot);
	}

	getServerStatuses(): readonly McpServerStatus[] {
		return this.#servers;
	}

	update(snapshot: McpWireStatusSnapshot): void {
		this.#servers = mapSnapshot(snapshot);
	}
}

export function createMcpWireStatusAdapter(snapshot: McpWireStatusSnapshot): McpWireStatusAdapter {
	return new McpWireStatusAdapter(snapshot);
}

export type ProcessMcpWireStatusOptions = {
	readonly agentDir?: string;
	readonly cwd: string;
	readonly env?: Record<string, string | undefined>;
};

/**
 * Build the threadless fallback from the process's trusted global config.
 *
 * This intentionally does not consult McpService: that singleton is reused by
 * loaded sessions, so its latest snapshot is neither process-scoped nor stable
 * before the first session attaches.
 */
export function createProcessMcpWireStatusAdapter(options: ProcessMcpWireStatusOptions): McpWireStatusAdapter {
	const config = loadMcpConfig({ ...options, projectTrusted: false });
	const servers = Object.values(config.servers)
		.filter((server) => server.source === "global")
		.map(toConfiguredServer);
	return createMcpWireStatusAdapter({ servers });
}

/** Resolves loaded-thread adapters while retaining an explicit process scope. */
export class McpWireStatusRegistry {
	#global: McpWireStatusAdapter | undefined;
	readonly #threads = new Map<string, McpWireStatusAdapter>();

	constructor(global?: McpWireStatusAdapter) {
		this.#global = global;
	}

	setGlobal(adapter: McpWireStatusAdapter): void {
		this.#global = adapter;
	}

	registerThread(threadId: string, adapter: McpWireStatusAdapter): void {
		this.#threads.set(threadId, adapter);
	}

	removeThread(threadId: string): void {
		this.#threads.delete(threadId);
	}

	resolve(threadId?: string | null): McpWireStatusAdapter | undefined {
		if (threadId === undefined || threadId === null) return this.#global;
		return this.#threads.get(threadId);
	}
}

export function createMcpWireStatusRegistry(global?: McpWireStatusAdapter): McpWireStatusRegistry {
	return new McpWireStatusRegistry(global);
}

function mapSnapshot(snapshot: McpWireStatusSnapshot): readonly McpServerStatus[] {
	return [...snapshot.servers]
		.sort((left, right) => left.name.localeCompare(right.name))
		.map(
			(server) =>
				({
					name: server.name,
					serverInfo: server.serverInfo === null ? null : mapServerInfo(server.serverInfo),
					tools: mapTools(server.tools),
					resources: server.resources.map(mapResource),
					resourceTemplates: server.resourceTemplates.map(mapResourceTemplate),
					authStatus: server.authStatus,
				}) satisfies McpServerStatus,
		);
}

function toConfiguredServer(server: ResolvedMcpServer): McpWireStatusServer {
	return {
		name: server.name,
		serverInfo: null,
		tools: [],
		resources: [],
		resourceTemplates: [],
		authStatus: configuredAuthStatus(server),
	};
}

function configuredAuthStatus(server: ResolvedMcpServer): McpWireAuthStatus {
	const mode = server.config === undefined ? "none" : resolveAuthMode(server.config);
	if (mode === "none") return "unsupported";
	if (mode === "bearer") return "bearerToken";
	return "notLoggedIn";
}

function mapServerInfo(info: McpWireServerInfo): McpServerInfo {
	return {
		name: info.name,
		title: info.title,
		version: info.version,
		description: info.description,
		icons: info.icons === null ? null : info.icons.map(toJsonValue),
		websiteUrl: info.websiteUrl,
	};
}

function mapTools(tools: readonly McpWireTool[]): Readonly<Record<string, Tool | undefined>> {
	const mapped: Record<string, Tool | undefined> = {};
	for (const tool of tools) mapped[tool.name] = mapTool(tool);
	return mapped;
}

function mapTool(tool: McpWireTool): Tool {
	return {
		name: tool.name,
		...(tool.title === undefined ? {} : { title: tool.title }),
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema: toJsonValue(tool.inputSchema),
		...(tool.outputSchema === undefined ? {} : { outputSchema: toJsonValue(tool.outputSchema) }),
		...(tool.annotations === undefined ? {} : { annotations: toJsonValue(tool.annotations) }),
		...(tool.icons === undefined ? {} : { icons: tool.icons.map(toJsonValue) }),
		...(tool._meta === undefined ? {} : { _meta: toJsonValue(tool._meta) }),
	};
}

function mapResource(resource: McpWireResource): Resource {
	return {
		uri: resource.uri,
		name: resource.name,
		...(resource.title === undefined ? {} : { title: resource.title }),
		...(resource.description === undefined ? {} : { description: resource.description }),
		...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
		...(resource.size === undefined ? {} : { size: resource.size }),
		...(resource.annotations === undefined ? {} : { annotations: toJsonValue(resource.annotations) }),
		...(resource.icons === undefined ? {} : { icons: resource.icons.map(toJsonValue) }),
		...(resource._meta === undefined ? {} : { _meta: toJsonValue(resource._meta) }),
	};
}

function mapResourceTemplate(template: McpWireResourceTemplate): ResourceTemplate {
	return {
		uriTemplate: template.uriTemplate,
		name: template.name,
		...(template.title === undefined ? {} : { title: template.title }),
		...(template.description === undefined ? {} : { description: template.description }),
		...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
		...(template.annotations === undefined ? {} : { annotations: toJsonValue(template.annotations) }),
		...(template.icons === undefined ? {} : { icons: template.icons.map(toJsonValue) }),
		...(template._meta === undefined ? {} : { _meta: toJsonValue(template._meta) }),
	};
}

function toJsonValue(value: McpWireJsonValue): JsonValue {
	return value;
}
