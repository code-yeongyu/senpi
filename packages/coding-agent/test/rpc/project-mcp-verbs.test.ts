/**
 * senpi#6485: `get_project_mcp_servers` / `set_project_mcp_servers` read and edit the session folder's project MCP file
 * over RPC, so a client that reaches the folder only through its engine edits MCP servers the way a local one does.
 * One test per gate and per refusal; every accepted write answers the read-back `get_project_mcp_servers` gives.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectTrustStore } from "../../src/core/trust-manager.ts";
import { classifyRpcMethod } from "../../src/modes/rpc/method-classes.ts";
import {
	disposeFolderHosts,
	type FolderHost,
	PROJECT_CONFIG_DIR,
	startFolderHost,
	type WireRecord,
} from "./project-folder-verbs-host.ts";

interface McpData {
	path: string;
	exists: boolean;
	mcpServers: Record<string, unknown> | null;
	parseError: string | null;
	etag: string | null;
	projectTrusted: boolean;
}

const MCP_PATH = `${PROJECT_CONFIG_DIR}/mcp.json`;
const SERVER = { command: "node", args: ["server.js"] };

const get = (host: FolderHost) => host.call("get_project_mcp_servers");
const set = (host: FolderHost, patch: unknown, ifEtag: unknown) =>
	host.call("set_project_mcp_servers", { patch, ifEtag });
const stored = (host: FolderHost) => readFileSync(join(host.cwd, MCP_PATH), "utf8");

async function trustedWithServer(host: FolderHost): Promise<McpData> {
	await host.trust();
	const created = await set(host, { alpha: SERVER }, null);
	expect(created).toMatchObject({ success: true });
	return created.data as McpData;
}

afterEach(disposeFolderHosts);

describe("project MCP verbs: classes and session", () => {
	it("classes both verbs as device_admin", () => {
		expect(classifyRpcMethod({ type: "get_project_mcp_servers", sessionId: "a" })).toBe("device_admin");
		expect(classifyRpcMethod({ type: "set_project_mcp_servers", sessionId: "a", patch: {}, ifEtag: null })).toBe(
			"device_admin",
		);
	});

	it("refuses both verbs for a session the host does not have", async () => {
		const host = await startFolderHost();
		const commands: WireRecord[] = [
			{ type: "get_project_mcp_servers" },
			{ type: "set_project_mcp_servers", patch: { alpha: SERVER }, ifEtag: null },
		];
		for (const command of commands) {
			expect(await host.send({ ...command, sessionId: "no-such-session" })).toMatchObject({
				success: false,
				error: "unknown_session",
			});
		}
		expect(existsSync(join(host.cwd, MCP_PATH))).toBe(false);
	});
});

describe("set_project_mcp_servers: accepted writes", () => {
	it("creates, renames in one write and deletes, each answering the read-back", async () => {
		const host = await startFolderHost();
		await host.trust();
		expect(await get(host)).toMatchObject({
			success: true,
			command: "get_project_mcp_servers",
			data: { path: MCP_PATH, exists: false, mcpServers: null, parseError: null, etag: null, projectTrusted: true },
		});
		const created = await set(host, { alpha: SERVER, beta: SERVER }, null);
		expect(created).toMatchObject({ success: true, command: "set_project_mcp_servers" });
		const first = created.data as McpData;
		expect(first).toMatchObject({ exists: true, mcpServers: { alpha: SERVER, beta: SERVER }, parseError: null });
		expect((await get(host)).data).toEqual(first);

		const renamed = (await set(host, { alpha: null, gamma: SERVER }, first.etag)).data as McpData;
		expect(renamed.mcpServers).toEqual({ beta: SERVER, gamma: SERVER });
		expect(renamed.etag).not.toBe(first.etag);
		expect(JSON.parse(stored(host))).toEqual({ mcpServers: { beta: SERVER, gamma: SERVER } });
		expect((await get(host)).data).toEqual(renamed);
	});

	it("keeps the file's other keys and the servers the patch does not name, as stored", async () => {
		const host = await startFolderHost();
		await host.trust();
		const kept = { command: "kept", env: { MODE: "kept" } };
		mkdirSync(join(host.cwd, PROJECT_CONFIG_DIR), { recursive: true });
		writeFileSync(join(host.cwd, MCP_PATH), JSON.stringify({ settings: {}, mcpServers: { kept } }));
		const before = (await get(host)).data as McpData;
		expect(await set(host, { added: SERVER }, before.etag)).toMatchObject({ success: true });
		expect(JSON.parse(stored(host))).toEqual({ settings: {}, mcpServers: { kept, added: SERVER } });
	});
});

describe("set_project_mcp_servers: refusals", () => {
	it("refuses a write while the folder is untrusted and creates nothing", async () => {
		const host = await startFolderHost();
		expect(await set(host, { alpha: SERVER }, null)).toMatchObject({
			success: false,
			errorCode: "project_not_trusted",
		});
		expect(existsSync(join(host.cwd, MCP_PATH))).toBe(false);
	});

	it("checks trust on every write: trust withdrawn over RPC refuses the next write", async () => {
		const host = await startFolderHost();
		const first = await trustedWithServer(host);
		await host.call("set_project_trust", { choice: "do_not_trust" });
		expect(await set(host, { beta: SERVER }, first.etag)).toMatchObject({
			success: false,
			errorCode: "project_not_trusted",
		});
		expect(JSON.parse(stored(host))).toEqual({ mcpServers: { alpha: SERVER } });
	});

	it("checks trust on every write: a 'do not trust' saved by another session refuses the next write", async () => {
		const host = await startFolderHost();
		const first = await trustedWithServer(host);
		new ProjectTrustStore(host.agentDir).set(host.cwd, false);
		expect(await set(host, { beta: SERVER }, first.etag)).toMatchObject({
			success: false,
			errorCode: "project_not_trusted",
		});
		expect(JSON.parse(stored(host))).toEqual({ mcpServers: { alpha: SERVER } });
	});

	it("refuses a stale etag and a create over an existing file", async () => {
		const host = await startFolderHost();
		const first = await trustedWithServer(host);
		const second = (await set(host, { beta: SERVER }, first.etag)).data as McpData;
		expect(await set(host, { gamma: SERVER }, first.etag)).toMatchObject({
			success: false,
			errorCode: "project_file_conflict",
			errorData: { currentEtag: second.etag, exists: true },
		});
		expect(await set(host, { gamma: SERVER }, null)).toMatchObject({
			success: false,
			errorCode: "project_file_conflict",
		});
		expect(JSON.parse(stored(host))).toEqual({ mcpServers: { alpha: SERVER, beta: SERVER } });
	});

	it.each(["{ not json", "[1]"])("reports a file that does not parse (%j) and never writes over it", async (bytes) => {
		const host = await startFolderHost();
		await host.trust();
		mkdirSync(join(host.cwd, PROJECT_CONFIG_DIR), { recursive: true });
		writeFileSync(join(host.cwd, MCP_PATH), bytes);
		const read = (await get(host)).data as McpData;
		expect(read).toMatchObject({ exists: true, mcpServers: null, parseError: expect.any(String) });
		expect(read.etag).toEqual(expect.any(String));
		expect(await set(host, { alpha: SERVER }, read.etag)).toMatchObject({
			success: false,
			errorCode: "project_mcp_config_unparseable",
			errorData: { parseError: read.parseError },
		});
		expect(stored(host)).toBe(bytes);
	});

	it.each([
		["a stdio server without a command", { bad: { type: "stdio" } }],
		["an http server without a url", { bad: { type: "http" } }],
		["a server that is not an object", { bad: 42 }],
	])("refuses a candidate the engine's loader rejects: %s", async (_label, patch) => {
		const host = await startFolderHost();
		const first = await trustedWithServer(host);
		expect(await set(host, patch, first.etag)).toMatchObject({
			success: false,
			errorCode: "project_mcp_config_invalid",
		});
		expect(JSON.parse(stored(host))).toEqual({ mcpServers: { alpha: SERVER } });
	});

	it.each([
		["a non-object patch", "alpha", null],
		["a missing etag", { alpha: SERVER }, undefined],
	])("refuses %s as invalid_argument", async (_label, patch, ifEtag) => {
		const host = await startFolderHost();
		await host.trust();
		expect(await set(host, patch, ifEtag)).toMatchObject({ success: false, errorCode: "invalid_argument" });
	});

	it("routes the write through the machine's own edit permission: a deny refuses it", async () => {
		const host = await startFolderHost({ settings: { permission: { edit: { "**/mcp.json": "deny" } } } });
		await host.trust();
		expect(await set(host, { alpha: SERVER }, null)).toMatchObject({
			success: false,
			errorCode: "project_file_permission_denied",
		});
		expect(existsSync(join(host.cwd, MCP_PATH))).toBe(false);
	});
});

describe("project MCP verbs: containment", () => {
	it("refuses a project config folder linked outside the folder, and leaves the target alone", async () => {
		const host = await startFolderHost({
			prepare: ({ cwd, outside }) => {
				renameSync(join(cwd, PROJECT_CONFIG_DIR), join(outside, "config"));
				writeFileSync(join(outside, "config", "mcp.json"), JSON.stringify({ mcpServers: {} }));
				symlinkSync(join(outside, "config"), join(cwd, PROJECT_CONFIG_DIR));
			},
		});
		await host.trust();
		expect(await get(host)).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(await set(host, { alpha: SERVER }, null)).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(readFileSync(join(host.outside, "config", "mcp.json"), "utf8")).toBe('{"mcpServers":{}}');
	});

	it("refuses a project MCP file that is itself a link, and leaves the target alone", async () => {
		const host = await startFolderHost({
			prepare: ({ cwd, outside }) => {
				writeFileSync(join(outside, "mcp.json"), "{}");
				symlinkSync(join(outside, "mcp.json"), join(cwd, MCP_PATH));
			},
		});
		await host.trust();
		expect(await get(host)).toMatchObject({ success: false, errorCode: "project_file_not_allowed" });
		expect(await set(host, { alpha: SERVER }, null)).toMatchObject({
			success: false,
			errorCode: "project_file_not_allowed",
		});
		expect(readFileSync(join(host.outside, "mcp.json"), "utf8")).toBe("{}");
	});
});
