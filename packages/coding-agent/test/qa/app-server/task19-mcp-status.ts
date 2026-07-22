import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Api, getModel, type Model } from "@earendil-works/pi-ai/compat";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { ServerCore } from "../../../src/modes/app-server/server/server-core.ts";
import {
	createMcpWireStatusAdapter,
	type McpWireStatusServer,
} from "../../../src/modes/app-server/threads/mcp-wire-status.ts";
import { ThreadRegistry, type ThreadRegistryOptions } from "../../../src/modes/app-server/threads/registry.ts";

const root = await mkdtemp(join(tmpdir(), "senpi-task19-mcp-status-"));
const firstCwd = join(root, "first");
const secondCwd = join(root, "second");
const firstAdapter = createMcpWireStatusAdapter({
	servers: [connectedServer("alpha", "bearerToken"), unconnectedServer("alpha-offline", "notLoggedIn")],
});
const secondAdapter = createMcpWireStatusAdapter({ servers: [connectedServer("beta", "oAuth")] });
const globalAdapter = createMcpWireStatusAdapter({ servers: [unconnectedServer("global", "unsupported")] });
const adaptersByCwd = new Map([
	[firstCwd, firstAdapter],
	[secondCwd, secondAdapter],
]);
const requestedModel: Model<Api> = getModel("openai", "gpt-5");
const createSession: ThreadRegistryOptions["createSession"] = async (options) => {
	const adapter = options.cwd === undefined ? undefined : adaptersByCwd.get(options.cwd);
	if (adapter === undefined) throw new Error(`Missing MCP test adapter for ${options.cwd ?? "<unset cwd>"}`);
	const result = await createAgentSession({
		...options,
		model: options.model ?? requestedModel,
		autoTitleSessions: false,
	});
	return { ...result, mcpWireStatusAdapter: adapter };
};
const threads = new ThreadRegistry({
	agentDir: join(root, "agent"),
	sessionDir: join(root, "sessions"),
	createSession,
	mcpWireStatusAdapter: globalAdapter,
});
const sent: unknown[] = [];
const core = new ServerCore({
	codexHome: join(root, "agent"),
	serverCwd: root,
	threads,
	version: "2026.7.2",
});
const connection = core.addConnection({
	id: "task19-mcp-status",
	transportKind: "stdio",
	send: (message) => {
		sent.push(message);
	},
	close: () => undefined,
});

try {
	await mkdir(firstCwd, { recursive: true });
	await mkdir(secondCwd, { recursive: true });
	const firstThread = await threads.createThread({ cwd: firstCwd });
	const secondThread = await threads.createThread({ cwd: secondCwd });

	await core.receive(connection.id, {
		kind: "request",
		message: {
			id: 1,
			method: "initialize",
			params: {
				clientInfo: { name: "qa", title: "QA", version: "0.0.1" },
				capabilities: { experimentalApi: false, requestAttestation: false },
			},
		},
	});

	await core.receive(connection.id, {
		kind: "request",
		message: {
			id: 2,
			method: "mcpServerStatus/list",
			params: { threadId: firstThread.id, detail: "full", limit: 1 },
		},
	});
	const firstPage = resultRecord(sent[1]);
	const firstPageHasCursor = firstPage.nextCursor === "1";

	await core.receive(connection.id, {
		kind: "request",
		message: {
			id: 3,
			method: "mcpServerStatus/list",
			params: { threadId: firstThread.id, detail: "toolsAndAuthOnly", limit: 2 },
		},
	});
	const filteredServers = arrayAt(resultRecord(sent[2]), "data");
	const serversCount = filteredServers.length;
	const offline = filteredServers.find((server) => isRecord(server) && server.name === "alpha-offline");
	const connected = filteredServers.find((server) => isRecord(server) && server.name === "alpha");
	const unconnectedListed =
		isRecord(offline) && offline.serverInfo === null && offline.authStatus === "notLoggedIn" ? 1 : 0;
	const detailFiltered =
		isRecord(connected) &&
		connected.serverInfo === null &&
		Array.isArray(connected.resources) &&
		connected.resources.length === 0 &&
		Array.isArray(connected.resourceTemplates) &&
		connected.resourceTemplates.length === 0 &&
		isRecord(connected.tools) &&
		isRecord(connected.tools.search)
			? 1
			: 0;

	await core.receive(connection.id, {
		kind: "request",
		message: { id: 4, method: "mcpServerStatus/list", params: { threadId: secondThread.id } },
	});
	const secondServers = arrayAt(resultRecord(sent[3]), "data");
	const distinctThread = secondServers.length === 1 && isRecord(secondServers[0]) && secondServers[0].name === "beta";

	await core.receive(connection.id, {
		kind: "request",
		message: { id: 5, method: "mcpServerStatus/list", params: {} },
	});
	const globalServers = arrayAt(resultRecord(sent[4]), "data");
	const globalFallback =
		globalServers.length === 1 && isRecord(globalServers[0]) && globalServers[0].name === "global";

	console.log(`SERVERS=${serversCount}`);
	console.log(`UNCONNECTED_LISTED=${unconnectedListed}`);
	console.log(`DETAIL_FILTERED=${detailFiltered}`);
	console.log(`THREAD_ISOLATED=${distinctThread ? 1 : 0}`);
	console.log(`GLOBAL_FALLBACK=${globalFallback ? 1 : 0}`);
	console.log("EXIT=0");
	if (
		serversCount < 2 ||
		!firstPageHasCursor ||
		unconnectedListed !== 1 ||
		detailFiltered !== 1 ||
		!distinctThread ||
		!globalFallback
	) {
		throw new Error("task19 MCP status assertions failed");
	}
} finally {
	for (const thread of threads.listLoaded()) threads.unloadThread(thread.id);
	await rm(root, { recursive: true, force: true });
}

function resultRecord(value: unknown): Record<string, unknown> {
	if (!isRecord(value) || !isRecord(value.result)) {
		throw new Error(`MCP status method did not return a result: ${JSON.stringify(value)}`);
	}
	return value.result;
}

function arrayAt(record: Record<string, unknown>, key: string): readonly unknown[] {
	const value = record[key];
	if (!Array.isArray(value)) throw new Error(`MCP status result field ${key} is not an array`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function connectedServer(name: string, authStatus: McpWireStatusServer["authStatus"]): McpWireStatusServer {
	return {
		name,
		serverInfo: {
			name,
			title: null,
			version: "1.0.0",
			description: null,
			icons: null,
			websiteUrl: null,
		},
		tools: [{ name: "search", inputSchema: { type: "object" } }],
		resources: [{ name: `${name}-resource`, uri: `${name}://resource` }],
		resourceTemplates: [{ name: `${name}-template`, uriTemplate: `${name}://{id}` }],
		authStatus,
	};
}

function unconnectedServer(name: string, authStatus: McpWireStatusServer["authStatus"]): McpWireStatusServer {
	return {
		name,
		serverInfo: null,
		tools: [],
		resources: [],
		resourceTemplates: [],
		authStatus,
	};
}
