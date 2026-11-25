import { createHash } from "node:crypto";
import {
	chmodSync,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { BridgeTool } from "./bridge-server.ts";
import { AGENT_NAME, BRIDGE_SERVER_NAME, BRIDGE_TOOL_PREFIX } from "./constants.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

const AGENT_DESCRIPTION = `Senpi host agent: every tool runs on the user's machine through the ${BRIDGE_SERVER_NAME} MCP server.`;

export type PrepareSessionWorkspaceInput = {
	readonly rootDir: string;
	readonly sessionKey: string;
	readonly systemPrompt: string;
	readonly projectCwd: string;
	readonly tools: readonly BridgeTool[];
};

export type PreparedSessionWorkspace = {
	readonly dir: string;
	readonly systemPromptAppend: string;
	readonly systemPromptHash: string;
	readonly toolsHash: string;
	readonly fingerprint: string;
};

export function hostPreamble(projectCwd: string): string {
	const onlyTools = `Your only tools are on the MCP server named "${BRIDGE_SERVER_NAME}"`;
	const onTheHost = "and they execute on the user's machine in that directory.";
	const slowResult = "A tool result can take a long time because senpi may ask the user for approval,";
	const waitForIt = "so wait for it and never retry a call just because it is slow.";
	return [
		"You are the model inside the senpi coding agent.",
		`The user's project directory is ${projectCwd}.`,
		`${onlyTools} ${onTheHost}`,
		`Every senpi tool named <name> (including tools returned by tool_search) is exposed as ${BRIDGE_TOOL_PREFIX}<name> and must always be called with that prefix, never unprefixed.`,
		"Call them through MCP with exact argument names from their schemas.",
		`${slowResult} ${waitForIt}`,
		"If you see a system notice about a server restart after tool_search, it is only the MCP bridge reloading newly discovered tools; your host session and background tasks are unaffected.",
		"Your own working directory is a private scratch space, never the project.",
	].join(" ");
}

export function composeSystemPromptAppend(projectCwd: string, systemPrompt: string): string {
	const preamble = hostPreamble(projectCwd);
	return systemPrompt.length > 0 ? `${preamble}\n\n${systemPrompt}` : preamble;
}

export function hashSystemPrompt(systemPromptAppend: string): string {
	return createHash("sha256").update(systemPromptAppend, "utf8").digest("hex");
}

export function hashTools(tools: readonly BridgeTool[]): string {
	return createHash("sha256").update(JSON.stringify(tools), "utf8").digest("hex");
}

export function sessionWorkspaceRoot(agentDir: string): string {
	return join(agentDir, "antigravity-acp", "workspaces");
}

export function prepareSessionWorkspace(input: PrepareSessionWorkspaceInput): PreparedSessionWorkspace {
	const dir = join(input.rootDir, sessionDirectoryName(input.sessionKey));
	const agentsDir = join(dir, ".agents");
	const agentDir = join(agentsDir, "agents", AGENT_NAME);
	ensurePrivateDir(dir);
	ensurePrivateDir(agentsDir);
	ensurePrivateDir(join(agentsDir, "agents"));
	ensurePrivateDir(agentDir);

	writeIfBytesChanged(join(agentDir, "agent.md"), renderAgentMarkdown());
	rmSync(join(agentsDir, "mcp_config.json"), { force: true });

	const systemPromptAppend = composeSystemPromptAppend(input.projectCwd, input.systemPrompt);
	const systemPromptHash = hashSystemPrompt(systemPromptAppend);
	const toolsHash = hashTools(input.tools);
	const fingerprint = createHash("sha256")
		.update(systemPromptHash, "utf8")
		.update("\n", "utf8")
		.update(toolsHash, "utf8")
		.digest("hex");

	return {
		dir,
		systemPromptAppend,
		systemPromptHash,
		toolsHash,
		fingerprint,
	};
}

export const DEFAULT_WORKSPACE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

export type PruneSessionWorkspacesOptions = {
	readonly maxAgeMs?: number;
	readonly activeDirs?: ReadonlySet<string>;
	readonly now?: number;
};

export function pruneStaleSessionWorkspaces(rootDir: string, options: PruneSessionWorkspacesOptions = {}): number {
	if (!existsSync(rootDir)) return 0;
	const maxAgeMs = options.maxAgeMs ?? DEFAULT_WORKSPACE_MAX_AGE_MS;
	const activeDirs = options.activeDirs;
	const now = options.now ?? Date.now();
	let removed = 0;
	let entries: Dirent[];
	try {
		entries = readdirSync(rootDir, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const fullPath = join(rootDir, entry.name);
		if (activeDirs?.has(fullPath)) continue;
		try {
			const mtimeMs = statSync(fullPath).mtimeMs;
			if (!Number.isFinite(mtimeMs) || now - mtimeMs < maxAgeMs) continue;
			rmSync(fullPath, { recursive: true, force: true });
			removed += 1;
		} catch {
			// Best-effort cleanup; ignore concurrent deletion or permission errors.
		}
	}
	return removed;
}

export function removeSessionWorkspace(dir: string): void {
	rmSync(dir, { recursive: true, force: true });
}

function sessionDirectoryName(sessionKey: string): string {
	return createHash("sha256").update(sessionKey, "utf8").digest("hex").slice(0, 16);
}

function renderAgentMarkdown(): string {
	return (
		[
			"---",
			`name: ${AGENT_NAME}`,
			`description: "${AGENT_DESCRIPTION}"`,
			"mainAgent: true",
			"subagent: false",
			"tools: []",
			"inheritCustomizations: false",
			"excludeDefaultComponents: true",
			'commandExecutionPolicy: "off"',
			"---",
		].join("\n") + "\n"
	);
}

function ensurePrivateDir(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: DIRECTORY_MODE });
	chmodSync(dir, DIRECTORY_MODE);
}

function writeIfBytesChanged(filePath: string, content: string): void {
	const next = Buffer.from(content, "utf8");
	if (existsSync(filePath) && readFileSync(filePath).equals(next)) {
		chmodSync(filePath, FILE_MODE);
		return;
	}
	writeFileSync(filePath, next, { mode: FILE_MODE });
	chmodSync(filePath, FILE_MODE);
}
