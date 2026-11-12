/**
 * `get_project_mcp_servers` / `set_project_mcp_servers` (senpi#6485): read and edit the session folder's project MCP
 * file over RPC, so a client that reaches the folder only through its engine edits MCP servers like a local one.
 *
 * Reading runs nothing, so trust does not gate it, and a file that does not parse is answered with `parseError`. A set
 * is one level deep: each patch entry replaces or (`null`) removes one server and every other key stays as stored, so a
 * rename is one atomic write. The candidate is checked with the MCP loader's own steps before anything is written, a
 * file that does not parse is never written over, and the write passes the per-write gates of `project-write-gate.ts`.
 * A project MCP file whose real path lies in the agent dir or in any user-global skill root the engine loads is the
 * global one (a flat agent dir with the session in its parent, or a selected root that holds the config folder) and
 * is refused.
 */

import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import { assertLoadableMcpConfig, McpConfigValidationError } from "../../core/extensions/builtin/mcp/config.ts";
import {
	insideUserGlobalRoots,
	PROJECT_FILE_MAX_BYTES,
	type ProjectFilePath,
	resolveProjectFile,
} from "./project-file-path.ts";
import { etagOf, readStored, type Stored, serializeWrite } from "./project-file-store.ts";
import {
	commitGuardedWrite,
	conflict,
	notAllowed,
	notTrusted,
	type ProjectWriteRefusal,
	projectTrustedForWrite,
	tooLarge,
} from "./project-write-gate.ts";
import {
	RPC_ERROR_INVALID_ARGUMENT,
	RPC_ERROR_PROJECT_MCP_CONFIG_INVALID,
	RPC_ERROR_PROJECT_MCP_CONFIG_UNPARSEABLE,
} from "./rpc-error-types.ts";

export interface RpcProjectMcpServers {
	cwd: string;
	/** The folder-relative path of the project MCP file. */
	path: string;
	exists: boolean;
	/** The servers as stored (placeholders unexpanded); `null` when the file is missing or does not parse. */
	mcpServers: Record<string, unknown> | null;
	parseError: string | null;
	/** Opaque version of the stored bytes; compare it, never parse it. */
	etag: string | null;
	projectTrusted: boolean;
}

export type ProjectMcpResult = { ok: true; data: RpcProjectMcpServers } | ProjectWriteRefusal;

type Parsed =
	| { readonly raw: Readonly<Record<string, unknown>>; readonly parseError: null }
	| { readonly raw: undefined; readonly parseError: string | null };

interface McpFileState {
	readonly data: RpcProjectMcpServers;
	readonly raw: Readonly<Record<string, unknown>> | undefined;
	readonly absolute: string;
	readonly mode: number | undefined;
	readonly missingFolders: readonly string[];
}

const MCP_FILE: ProjectFilePath = {
	relative: `${CONFIG_DIR_NAME}/mcp.json`,
	segments: [CONFIG_DIR_NAME, "mcp.json"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMcpFile(bytes: Buffer): Parsed {
	let value: unknown;
	try {
		value = JSON.parse(bytes.toString("utf8"));
	} catch (error) {
		return { raw: undefined, parseError: error instanceof Error ? error.message : String(error) };
	}
	if (!isRecord(value)) return { raw: undefined, parseError: "The file is not a JSON object." };
	if (value.mcpServers !== undefined && !isRecord(value.mcpServers)) {
		return { raw: undefined, parseError: "'mcpServers' is not a JSON object." };
	}
	return { raw: value, parseError: null };
}

function storedServers(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return isRecord(raw.mcpServers) ? raw.mcpServers : {};
}

async function readMcpState(session: AgentSession): Promise<McpFileState | ProjectWriteRefusal> {
	const cwd = session.sessionManager.getCwd();
	const resolved = await resolveProjectFile(cwd, MCP_FILE);
	if (
		!resolved.ok ||
		(await insideUserGlobalRoots(session.agentDir, session.resourceLoader.getUserSkillRoots(), resolved.absolute))
	) {
		return notAllowed(MCP_FILE.relative);
	}
	const stored: Stored = resolved.exists ? await readStored(resolved.absolute) : { kind: "missing" };
	if (stored.kind === "refused") return notAllowed(MCP_FILE.relative);
	if (stored.kind === "too_large") return tooLarge();
	const parsed: Parsed = stored.kind === "file" ? parseMcpFile(stored.bytes) : { raw: undefined, parseError: null };
	return {
		data: {
			cwd,
			path: MCP_FILE.relative,
			exists: stored.kind === "file",
			mcpServers: parsed.raw === undefined ? null : storedServers(parsed.raw),
			parseError: parsed.parseError,
			etag: stored.kind === "file" ? etagOf(stored.bytes) : null,
			projectTrusted: session.settingsManager.isProjectTrusted(),
		},
		raw: parsed.raw,
		absolute: resolved.absolute,
		mode: stored.kind === "file" ? stored.mode : undefined,
		missingFolders: resolved.missingFolders,
	};
}

export async function getProjectMcpServers(session: AgentSession): Promise<ProjectMcpResult> {
	const state = await readMcpState(session);
	return "ok" in state ? state : { ok: true, data: state.data };
}

function mergeServers(
	current: Readonly<Record<string, unknown>>,
	patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
	return Object.fromEntries([
		...Object.entries(current).filter(([name]) => !Object.hasOwn(patch, name)),
		...Object.entries(patch).filter(([, entry]) => entry !== null),
	]);
}

async function setChecked(
	session: AgentSession,
	patch: Readonly<Record<string, unknown>>,
	ifEtag: string | null,
): Promise<ProjectMcpResult> {
	const state = await readMcpState(session);
	if ("ok" in state) return state;
	if (state.data.etag !== ifEtag) return conflict(MCP_FILE.relative, state.data.etag);
	if (state.data.parseError !== null) {
		return {
			ok: false,
			message: `${MCP_FILE.relative} does not parse (${state.data.parseError}); fix it before editing servers.`,
			errorCode: RPC_ERROR_PROJECT_MCP_CONFIG_UNPARSEABLE,
			errorData: { parseError: state.data.parseError },
		};
	}
	const raw = state.raw ?? {};
	const candidate = { ...raw, mcpServers: mergeServers(storedServers(raw), patch) };
	try {
		assertLoadableMcpConfig(candidate, state.absolute);
	} catch (error) {
		if (!(error instanceof McpConfigValidationError)) throw error;
		return { ok: false, message: error.message, errorCode: RPC_ERROR_PROJECT_MCP_CONFIG_INVALID };
	}
	const content = `${JSON.stringify(candidate, null, 2)}\n`;
	if (Buffer.byteLength(content, "utf8") > PROJECT_FILE_MAX_BYTES) return tooLarge();
	const refused = await commitGuardedWrite(session, {
		relative: MCP_FILE.relative,
		absolute: state.absolute,
		content,
		expectedEtag: state.data.etag,
		mode: state.mode,
		missingFolders: state.missingFolders,
	});
	return refused ?? getProjectMcpServers(session);
}

export async function setProjectMcpServers(
	session: AgentSession,
	patch: unknown,
	ifEtag: unknown,
): Promise<ProjectMcpResult> {
	if (!isRecord(patch) || (ifEtag !== null && typeof ifEtag !== "string")) {
		return {
			ok: false,
			message:
				"set_project_mcp_servers requires an object 'patch' (server name to entry, or null to remove) and 'ifEtag' (the etag read, or null to create).",
			errorCode: RPC_ERROR_INVALID_ARGUMENT,
		};
	}
	if (!(await projectTrustedForWrite(session))) return notTrusted();
	const key = join(session.sessionManager.getCwd(), MCP_FILE.relative);
	return serializeWrite(key, () => setChecked(session, patch, ifEtag));
}
