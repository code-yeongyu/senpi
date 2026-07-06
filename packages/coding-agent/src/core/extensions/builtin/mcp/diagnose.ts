import { execFile } from "node:child_process";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerConfig } from "./config-schema.ts";
import { ConnectError } from "./errors.ts";
import type { McpLogger } from "./log.ts";
import { redactMcpLogText } from "./log.ts";

export const MCP_STDIO_DIAGNOSTIC_TIMEOUT_MS = 5000;
const MCP_STDIO_DIAGNOSTIC_MAX_BYTES = 2048;

export interface McpStdioDiagnosticOptions {
	readonly config: McpServerConfig;
	readonly env?: Record<string, string | undefined>;
	readonly logger: McpLogger;
}

export interface McpConnectFailureDiagnosticOptions extends McpStdioDiagnosticOptions {
	readonly serverName: string;
	readonly cause: Error;
}

interface ExecResult {
	readonly error: Error | null;
	readonly stdout: string;
	readonly stderr: string;
}

export async function diagnoseMcpConnectFailure(options: McpConnectFailureDiagnosticOptions): Promise<ConnectError> {
	const diagnostic = await maybeDiagnoseStdioFailure(options);
	const message =
		diagnostic === null || diagnostic.length === 0
			? `MCP server ${options.serverName} failed during connect: ${options.cause.message}`
			: `MCP server ${options.serverName} failed during connect: ${options.cause.message}\n${diagnostic}`;
	return new ConnectError(message, {
		cause: options.cause,
		phase: "connect",
		retriable: true,
		serverName: options.serverName,
	});
}

export async function maybeDiagnoseStdioFailure(options: McpStdioDiagnosticOptions): Promise<string | null> {
	if (options.config.type !== "stdio") return null;
	const captured = extractCapturedStderr(options.logger);
	if (captured.length > 0) return boundDiagnostic(captured);
	const command = options.config.command;
	if (command === undefined || command.trim().length === 0) return null;
	const result = await execFileForDiagnostics(command, options.config.args, {
		cwd: options.config.cwd,
		env: buildDiagnosticEnv(options),
	});
	if (isNodeErrorCode(result.error, "ENOENT")) return commandNotFoundDiagnostic(command, options);
	const lines = meaningfulLines(`${result.stderr}\n${result.stdout}`);
	if (lines.length > 0) return boundDiagnostic(lines);
	if (isTimedOut(result.error)) return `diagnostic rerun timed out after ${MCP_STDIO_DIAGNOSTIC_TIMEOUT_MS}ms`;
	return null;
}

function extractCapturedStderr(logger: McpLogger): string[] {
	const messages: string[] = [];
	for (const line of logger.getRingBuffer()) {
		const parsed = parseLogLine(line);
		if (parsed?.channel === "stderr" && typeof parsed.message === "string") {
			messages.push(parsed.message);
		}
	}
	return meaningfulLines(messages.join("\n"));
}

function parseLogLine(line: string): { channel?: unknown; message?: unknown } | null {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed === "object" && parsed !== null) return parsed as { channel?: unknown; message?: unknown };
	} catch {
		return null;
	}
	return null;
}

function meaningfulLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => redactMcpLogText(line.trim()))
		.filter((line) => line.length > 0);
}

function boundDiagnostic(lines: readonly string[]): string {
	let output = "";
	for (const line of lines) {
		const next = output.length === 0 ? line : `${output}\n${line}`;
		if (Buffer.byteLength(next, "utf8") > MCP_STDIO_DIAGNOSTIC_MAX_BYTES) break;
		output = next;
	}
	return output || lines[0]?.slice(0, MCP_STDIO_DIAGNOSTIC_MAX_BYTES) || "";
}

function execFileForDiagnostics(
	command: string,
	args: readonly string[] | undefined,
	options: { cwd?: string; env: Record<string, string> },
): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(
			command,
			args ?? [],
			{
				cwd: options.cwd,
				env: options.env,
				killSignal: "SIGKILL",
				maxBuffer: MCP_STDIO_DIAGNOSTIC_MAX_BYTES * 4,
				timeout: MCP_STDIO_DIAGNOSTIC_TIMEOUT_MS,
			},
			(error, stdout, stderr) => {
				resolve({
					error,
					stdout,
					stderr,
				});
			},
		);
	});
}

function buildDiagnosticEnv(options: McpStdioDiagnosticOptions): Record<string, string> {
	return {
		...getDefaultEnvironment(),
		...definedEnv(options.env),
		...(options.config.env ?? {}),
	};
}

function commandNotFoundDiagnostic(command: string, options: McpStdioDiagnosticOptions): string {
	const env = buildDiagnosticEnv(options);
	const cwd = options.config.cwd ?? process.cwd();
	const path = env.PATH ?? "";
	return [
		`command not found: ${redactMcpLogText(command)}`,
		`cwd: ${redactMcpLogText(cwd)}`,
		`PATH: ${redactMcpLogText(path)}`,
		"Install the command, add it to PATH, or configure an absolute command path in mcp.json.",
	].join("\n");
}

function definedEnv(env: Record<string, string | undefined> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env ?? {})) {
		if (value !== undefined) result[key] = value;
	}
	return result;
}

function isTimedOut(error: Error | null): boolean {
	if (error === null) return false;
	const signal = getProperty(error, "signal");
	return signal === "SIGKILL" || error.message.includes("timed out");
}

function isNodeErrorCode(error: Error | null, code: string): boolean {
	return error !== null && getProperty(error, "code") === code;
}

function getProperty(value: object, key: string): unknown {
	return (value as Record<string, unknown>)[key];
}
