import { spawn } from "node:child_process";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { truncateHead, truncateTail } from "../../tools/truncate.ts";
import type { ExtensionAPI } from "../types.ts";

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 36 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8 * 1024;
const AGY_TIMEOUT = "10m";
const CHILD_ENV_KEYS = [
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PATH",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
	"SYSTEMROOT",
] as const;

class AgySidecarError extends Error {
	override name = "AgySidecarError";
}

export function decodeAgyOutput(chunks: readonly Buffer[], totalBytes?: number): string {
	return Buffer.concat(chunks, totalBytes).toString("utf8");
}

function agyEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of CHILD_ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}

async function runAgy(
	task: string,
	model: string | undefined,
	mode: "plan" | "accept-edits",
	cwd: string,
	signal: AbortSignal | undefined,
): Promise<{ response: string; conversationId?: string; diagnostics: string; diagnosticsTruncated: boolean }> {
	if (signal?.aborted) throw new AgySidecarError("AGY delegation cancelled.");
	const args = ["-p", task, "--output-format", "json", "--print-timeout", AGY_TIMEOUT, "--mode", mode];
	if (model) args.push("--model", model);
	const child = spawn(process.env.SENPI_AGY_EXECUTABLE || "agy", args, {
		cwd,
		env: agyEnvironment(),
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	const stdoutChunks: Buffer[] = [];
	let stdoutBytes = 0;
	let stderrTail = Buffer.alloc(0);
	let diagnosticsTruncated = false;
	let overflow = false;
	let closed = false;
	const terminate = () => {
		if (closed) return;
		if (process.platform !== "win32" && child.pid !== undefined) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		} else {
			child.kill("SIGKILL");
		}
		child.stdout.destroy();
		child.stderr.destroy();
	};
	child.stdout.on("data", (chunk: Buffer) => {
		if (overflow) return;
		if (stdoutBytes + chunk.length > MAX_STDOUT_BYTES) {
			overflow = true;
			terminate();
			return;
		}
		stdoutChunks.push(chunk);
		stdoutBytes += chunk.length;
	});
	child.stderr.on("data", (chunk: Buffer) => {
		const next = Buffer.concat([stderrTail, chunk]);
		if (next.length > MAX_STDERR_BYTES) diagnosticsTruncated = true;
		stderrTail = next.subarray(Math.max(0, next.length - MAX_STDERR_BYTES));
	});
	signal?.addEventListener("abort", terminate, { once: true });
	if (signal?.aborted) terminate();
	let exitCode: number | null;
	try {
		try {
			exitCode = await new Promise<number | null>((resolve, reject) => {
				child.once("error", reject);
				child.once("close", (code) => {
					closed = true;
					resolve(code);
				});
			});
		} catch (error) {
			if (signal?.aborted) throw new AgySidecarError("AGY delegation cancelled.");
			if (error instanceof Error && "code" in error && error.code === "ENOENT") {
				throw new AgySidecarError("AGY CLI not found. Install the official agy binary and sign in with agy.");
			}
			throw error;
		}
	} finally {
		signal?.removeEventListener("abort", terminate);
	}
	const stderr = stderrTail.toString("utf8").trim();
	if (signal?.aborted) throw new AgySidecarError("AGY delegation cancelled.");
	if (overflow) throw new AgySidecarError("AGY output exceeded the 2 MiB response limit.");
	let result: unknown;
	try {
		result = JSON.parse(decodeAgyOutput(stdoutChunks, stdoutBytes));
	} catch (error) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new AgySidecarError(`AGY returned invalid JSON (exit ${exitCode}). ${stderr.trim().slice(-1000)}`);
	}
	if (typeof result !== "object" || result === null || !("status" in result) || typeof result.status !== "string") {
		throw new AgySidecarError("AGY returned a response without a status.");
	}
	if (exitCode !== 0 || result.status !== "SUCCESS") {
		const detail = "error" in result && typeof result.error === "string" ? result.error : stderr.trim();
		throw new AgySidecarError(`AGY ${result.status} (exit ${exitCode}): ${detail.slice(0, 2000)}`);
	}
	if (!("response" in result) || typeof result.response !== "string" || !result.response.trim()) {
		throw new AgySidecarError("AGY completed without a response.");
	}
	return {
		response: result.response,
		...("conversation_id" in result && typeof result.conversation_id === "string"
			? { conversationId: result.conversation_id }
			: {}),
		diagnostics: stderr,
		diagnosticsTruncated,
	};
}

export default function agySidecarExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "agy",
		label: "Antigravity CLI",
		description:
			"Delegate a bounded task to the official Antigravity CLI as a separate agent. Requires agy installed and signed in; this is not a selectable OmO model. Defaults to read-only plan mode. AGY may soft-deny actions requiring permission; inspect its diagnostics before claiming the task succeeded.",
		parameters: Type.Object({
			task: Type.String({ minLength: 1, description: "Self-contained task for the AGY agent" }),
			model: Type.Optional(Type.String({ description: "AGY model slug (omit to use its default)" })),
			mode: Type.Optional(StringEnum(["plan", "accept-edits"] as const)),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await runAgy(params.task, params.model, params.mode ?? "plan", ctx.cwd, signal);
			const response = truncateHead(result.response, { maxLines: 1700, maxBytes: MAX_RESPONSE_BYTES });
			const diagnostics = truncateTail(result.diagnostics, { maxLines: 200, maxBytes: MAX_DIAGNOSTIC_BYTES });
			const diagnosticsTruncated = result.diagnosticsTruncated || diagnostics.truncated;
			const warning = diagnosticsTruncated ? "AGY diagnostics were truncated; denied actions may be missing.\n" : "";
			const diagnosticText = result.diagnostics
				? `${warning}AGY diagnostics (check for denied actions):\n${diagnostics.content}\n\n`
				: warning;
			const responseText = response.truncated
				? `${response.content}\n\n[AGY response truncated at ${response.outputBytes} of ${response.totalBytes} bytes; request a shorter report.]`
				: response.content;
			return {
				content: [{ type: "text", text: `${diagnosticText}${responseText}` }],
				details: {
					conversationId: result.conversationId,
					truncated: response.truncated || diagnosticsTruncated,
					diagnosticsTruncated,
				},
			};
		},
	});
}
