import { createToolNamespace } from "./kernel-tools-define.js";
import { kernelToolError } from "./kernel-tools-errors.js";
import { kernelToolKey, MCP_TOOL_NAME_MAX_LENGTH, sanitizeNamePart } from "./kernel-tools-naming.js";
import { parseToolFunction } from "./kernel-tools-parse.js";
import { orderedArgs, resolveToolMetadata, validateInvokeArgs } from "./kernel-tools-schema.js";

export { createToolNamespace };

// "defined" and "undefine" are the tool namespace's own members, so a kernel tool by those names could never be reached.
const DEFAULT_RESERVED = Object.freeze(["__agent__", "__output__", "__schema__", "defined", "undefine"]);

function currentNames(source) {
	return typeof source === "function" ? source() : (source ?? []);
}

function hasNameKey(source, key) {
	return currentNames(source).some((name) => kernelToolKey(name) === key);
}

export function createKernelToolRegistry(options = {}) {
	const language = options.language ?? "js";
	let generation = options.generation ?? 1;
	const reservedKeys = new Set((options.reservedNames ?? DEFAULT_RESERVED).map(kernelToolKey));
	let hostSource = options.hostToolNames ?? [];
	let foreignSource = options.foreignLanguageNames ?? [];
	const entries = new Map();

	function assertJs() {
		if (language !== "js") throw kernelToolError("tools_unavailable", "Kernel tools are JavaScript-only");
	}

	function descriptorFor(entry) {
		return {
			name: entry.normalizedName,
			description: entry.description,
			input_schema: entry.input_schema,
			language: "js",
			kernel_generation: generation,
			definition_revision: entry.revision,
		};
	}

	return {
		get generation() {
			return generation;
		},
		define(fn, metadata) {
			if (options.disabled === true) throw kernelToolError("tools_unavailable", "kernel tools are turned off for this project (kernelTools.enabled is false)");
			assertJs();
			const parsed = parseToolFunction(fn);
			const resolved = resolveToolMetadata(metadata, parsed.params);
			const name = resolved.name ?? parsed.name;
			if (sanitizeNamePart(name) !== name || name.length > MCP_TOOL_NAME_MAX_LENGTH) {
				throw kernelToolError("invalid_tool_definition", "Kernel tool name must match MCP name grammar");
			}
			const normalizedName = name;
			const key = kernelToolKey(name);
			if (reservedKeys.has(key)) throw kernelToolError("reserved_tool_name", `Kernel tool name is reserved: ${name}`);
			if (hasNameKey(hostSource, key) || hasNameKey(foreignSource, key)) {
				throw kernelToolError("tool_name_collision", `Kernel tool name collides: ${name}`);
			}
			const existing = entries.get(key);
			if (existing && existing.originalName !== name) {
				throw kernelToolError("tool_name_collision", `Kernel tool name collides: ${name}`);
			}
			const entry = {
				originalName: name,
				normalizedName,
				fn,
				params: parsed.params,
				description: resolved.description,
				input_schema: resolved.input_schema,
				revision: existing ? existing.revision + 1 : 1,
			};
			entries.set(key, entry);
			return descriptorFor(entry);
		},
		describe(names) {
			assertJs();
			return {
				results: names.map((name) => {
					const entry = entries.get(kernelToolKey(name));
					if (!entry) {
						return {
							name,
							ok: false,
							error: { code: "kernel_tool_missing", message: `Kernel tool is not defined: ${name}` },
						};
					}
					return { name, ok: true, descriptor: descriptorFor(entry) };
				}),
			};
		},
		async invoke(request, signal) {
			assertJs();
			if (signal?.aborted) {
				throw signal.reason ?? kernelToolError("kernel_tool_failed", "Kernel tool call aborted");
			}
			if (request.kernel_generation !== generation) {
				throw kernelToolError("kernel_tool_stale", "Kernel tool descriptor generation is stale");
			}
			const entry = entries.get(kernelToolKey(request.name));
			if (!entry) throw kernelToolError("kernel_tool_missing", `Kernel tool is not defined: ${request.name}`);
			if (entry.revision !== request.definition_revision) {
				throw kernelToolError("kernel_tool_stale", "Kernel tool descriptor revision is stale");
			}
			validateInvokeArgs(entry.input_schema, request.args);
			try {
				const value = await entry.fn(...orderedArgs(entry.params, request.args));
				const live = entries.get(kernelToolKey(request.name));
				if (request.kernel_generation !== generation || live !== entry) {
					throw kernelToolError("kernel_tool_stale", "Kernel tool descriptor is stale");
				}
				return value;
			} catch (error) {
				if (error instanceof Error && typeof error.code === "string") throw error;
				throw kernelToolError("kernel_tool_failed", error instanceof Error ? error.message : String(error));
			}
		},
		defined() {
			return [...entries.values()].map((entry) => entry.normalizedName).sort();
		},
		undefine(name) {
			if (typeof name !== "string") return false;
			return entries.delete(kernelToolKey(name));
		},
		bumpGeneration() {
			generation += 1;
			entries.clear();
			return generation;
		},
		setCollisionNames(hostToolNames, foreignLanguageNames) {
			hostSource = hostToolNames ?? [];
			foreignSource = foreignLanguageNames ?? [];
		},
	};
}
