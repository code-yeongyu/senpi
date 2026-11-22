import type { ResolvedSandbox } from "../../config/feature-settings.ts";
import { marshalToolResult } from "../../tool/image.ts";
import type { EvalRuntimeInfo, ExecuteTool, HostCellExecutor } from "../../tool/types.ts";
import type { CodemodeSandbox } from "./vendor/pi-codemode/runtime/host.ts";
import type { CodemodeError, CodemodeOutputFrame, CodemodeTool } from "./vendor/pi-codemode/types.ts";

export interface SandboxCellOptions {
	readonly sandbox: ResolvedSandbox;
	readonly executeTool: ExecuteTool;
	readonly toolNames: () => readonly string[];
	readonly describeTool?: (name: string) => string | undefined;
	/** Where the QuickJS wasm lives; by default the installed `quickjs-wasi` package's file. */
	readonly wasmPath?: string;
}

/**
 * The runtime an isolated cell's result reports: the QuickJS build it runs on, never the persistent kernel's (senpi#2811).
 * Read from the installed quickjs-wasi package the wasm loads from, only when an isolated cell runs; when that package
 * cannot be resolved the cell itself fails with eval_isolate_unavailable, and the version says so.
 */
export function sandboxRuntimeInfo(): EvalRuntimeInfo {
	let version = "unavailable";
	try {
		// getBuiltinModule, not a static import: node:module would otherwise load with the extension.
		const manifest: unknown = process.getBuiltinModule("node:module").createRequire(import.meta.url)(
			"quickjs-wasi/package.json",
		);
		if (
			typeof manifest === "object" &&
			manifest !== null &&
			"version" in manifest &&
			typeof manifest.version === "string"
		)
			version = manifest.version;
	} catch {
		// Reported as "unavailable": the same missing package makes the cell fail with eval_isolate_unavailable.
	}
	return { name: "quickjs", version, isolation: "sandbox" };
}

// On the script's first line so reported line numbers still match the cell; globals, so a cell's own
// `const print` shadows them instead of failing as a redeclaration.
const OUTPUT_ALIASES =
	'globalThis.print = (...values) => text(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ")); globalThis.display = (value) => ((typeof value === "string" && value.startsWith("data:image/")) || (value !== null && typeof value === "object" && ("image_url" in value || value.type === "image")) ? image(value) : text(typeof value === "string" ? value : JSON.stringify(value))); globalThis.tool = tools; ';

const ERROR_CODES: Partial<Record<CodemodeError["kind"], string>> = {
	timeout: "eval_isolate_timeout",
	aborted: "eval_isolate_aborted",
	sandbox: "eval_isolate_unavailable",
};

function codeFor(error: CodemodeError): string | undefined {
	if (error.kind === "script" && error.reason === "memory") return "eval_isolate_memory_limit";
	if (error.kind === "script" && error.name === "CodemodeStoreDisabledError") return "eval_isolate_no_state";
	if (error.kind === "script" && error.reason === "unresolved") return "eval_isolate_unresolved_promise";
	return ERROR_CODES[error.kind];
}

/** The persistent kernel never sees an isolated cell; its tools go through executeTool so permission hooks still apply. */
export function sandboxCellExecutor(code: string, options: SandboxCellOptions): HostCellExecutor {
	return async ({ signal, emit }) => {
		let sandbox: CodemodeSandbox;
		try {
			// Lazy: the vendored QuickJS runtime loads only when a session runs its first isolated cell. The wasm is loaded
			// here, before any of the cell runs, so a missing runtime is reported as unavailable instead of failing inside
			// the script.
			const runtime = await import("./vendor/pi-codemode/runtime/host.ts");
			const { loadQuickJSWasm } = await import("./vendor/pi-codemode/wasm.ts");
			const wasm = await loadQuickJSWasm(options.wasmPath);
			const items = new Map<number, string[]>();
			const tools: CodemodeTool[] = options
				.toolNames()
				.filter((name) => name !== "eval")
				.map((name) => ({
					name,
					description: options.describeTool?.(name) ?? "",
					execute: async (args: unknown, context: { signal: AbortSignal }) =>
						marshalToolResult(await options.executeTool(name, args, { signal: context.signal })),
				}));
			sandbox = new runtime.CodemodeSandbox({
				wasm,
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
			// The full error, paths included, goes to the host's own log so a maintainer can diagnose it; the cell gets
			// only what failed and the error's code. This covers every setup step: the runtime import, the tool list,
			// the wasm load and the sandbox itself.
			console.error("[senpi-codemode] isolated cell setup failed:", error);
			const code =
				error instanceof Error && "code" in error && typeof error.code === "string" ? ` (${error.code})` : "";
			return {
				ok: false,
				error: {
					name: "SandboxUnavailableError",
					message: `eval_isolate_unavailable: the QuickJS runtime for isolated cells could not be loaded${code}; nothing in the cell ran`,
				},
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
