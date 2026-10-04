import type { AgentToolResult } from "@code-yeongyu/senpi";
import type { ResolvedSandbox } from "../../config/feature-settings.ts";
import { marshalToolResult } from "../../tool/image.ts";
import type { ExecuteTool, HostCellExecutor } from "../../tool/types.ts";
import type { CodemodeSandbox } from "./vendor/pi-codemode/runtime/host.ts";
import type { CodemodeError, CodemodeOutputFrame, CodemodeTool } from "./vendor/pi-codemode/types.ts";

export interface SandboxCellOptions {
	readonly sandbox: ResolvedSandbox;
	readonly executeTool: ExecuteTool;
	readonly toolNames: () => readonly string[];
	readonly describeTool?: (name: string) => string | undefined;
	readonly loadRuntime?: () => Promise<typeof import("./vendor/pi-codemode/runtime/host.ts")>;
}

// On the script's first line so reported line numbers still match the cell; globals, so a cell's own
// `const print` shadows them instead of failing as a redeclaration.
const OUTPUT_ALIASES =
	'globalThis.print = (...values) => text(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ")); globalThis.display = (value) => (typeof value === "string" || (value !== null && typeof value === "object" && ("image_url" in value || value.type === "image")) ? image(value) : text(value)); ';

export class SandboxUnavailableError extends Error {
	readonly name = "SandboxUnavailableError";
	readonly code = "eval_isolate_unavailable";
}

const ERROR_CODES: Partial<Record<CodemodeError["kind"], string>> = {
	timeout: "eval_isolate_timeout",
	aborted: "eval_isolate_aborted",
	sandbox: "eval_isolate_unavailable",
};

function codeFor(error: CodemodeError): string | undefined {
	if (error.kind === "script" && /out of memory/i.test(error.message)) return "eval_isolate_memory_limit";
	if (error.kind === "script" && error.name === "CodemodeStoreDisabledError") return "eval_isolate_no_state";
	if (error.kind === "script" && /never settle|unresolved|waits on nothing/i.test(error.message)) {
		return "eval_isolate_unresolved_promise";
	}
	return ERROR_CODES[error.kind];
}

function senpiToolEnvelope(result: AgentToolResult<unknown>) {
	return marshalToolResult(result);
}

/** The persistent kernel never sees an isolated cell; its tools go through executeTool so permission hooks still apply. */
export function sandboxCellExecutor(code: string, options: SandboxCellOptions): HostCellExecutor {
	return async ({ signal, emit }) => {
		let sandbox: CodemodeSandbox;
		try {
			const runtime = await (options.loadRuntime?.() ?? import("./vendor/pi-codemode/runtime/host.ts"));
			const items = new Map<number, string[]>();
			const tools: CodemodeTool[] = options
				.toolNames()
				.filter((name) => name !== "eval")
				.map((name) => ({
					name,
					description: options.describeTool?.(name) ?? "",
					execute: async (args: unknown, context: { signal: AbortSignal }) =>
						senpiToolEnvelope(await options.executeTool(name, args, { signal: context.signal })),
				}));
			sandbox = new runtime.CodemodeSandbox({
				tools,
				timeoutMs: options.sandbox.timeoutSeconds * 1_000,
				memoryLimitBytes: options.sandbox.memoryMb * 1024 * 1024,
				output: "stream",
				builtins: { store: "reject" },
				onOutputFrame: (frame: CodemodeOutputFrame) => {
					const parts = items.get(frame.itemId) ?? [];
					parts.push(frame.chunk);
					if (!frame.final) {
						items.set(frame.itemId, parts);
						return;
					}
					items.delete(frame.itemId);
					const payload = parts.join("");
					if (frame.type === "image") {
						emit({ type: "display", mimeType: frame.mimeType ?? "image/png", dataBase64: payload });
					} else {
						emit({ type: "text", stream: "stdout", data: payload.endsWith("\n") ? payload : `${payload}\n` });
					}
				},
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				error: { name: "SandboxUnavailableError", message: `eval_isolate_unavailable: ${message}` },
			};
		}
		try {
			const result = await sandbox.execute(OUTPUT_ALIASES + code, { signal });
			if (result.ok) {
				return result.value === undefined
					? { ok: true }
					: {
							ok: true,
							valueRepr: typeof result.value === "string" ? result.value : JSON.stringify(result.value),
						};
			}
			const errorCode = codeFor(result.error);
			return {
				ok: false,
				error: {
					...(result.error.name === undefined ? {} : { name: result.error.name }),
					message: errorCode === undefined ? result.error.message : `${errorCode}: ${result.error.message}`,
					...(result.error.stack === undefined ? {} : { stack: result.error.stack }),
				},
			};
		} finally {
			await sandbox.close();
		}
	};
}
