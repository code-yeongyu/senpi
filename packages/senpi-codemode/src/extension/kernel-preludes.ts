import type { KernelPreludeContribution } from "@code-yeongyu/senpi";
import type { CodemodeRuntimeAPI } from "./runtime-factory.ts";

type ToolRegistry = Pick<CodemodeRuntimeAPI, "getActiveTools" | "getAllTools">;

/**
 * Kernel globals of the tools active right now. Read per cell, so a tool activated by `tool_search`, a by-name
 * call, or a command shows up in the next cell and a deactivated one disappears, whatever the registration order.
 */
export function activeKernelPreludes(pi: ToolRegistry): readonly KernelPreludeContribution[] {
	const active = new Set(pi.getActiveTools());
	return pi.getAllTools().flatMap((tool) => (tool.kernelPrelude && active.has(tool.name) ? [tool.kernelPrelude] : []));
}

/** Identity of the prompt's contribution doc lines; the eval tool re-registers only when it changes. */
export function kernelPreludeDocsKey(preludes: readonly KernelPreludeContribution[]): string {
	return preludes.map((prelude) => prelude.documentation).join("\n");
}

/**
 * The contributions the eval description documents. Like the monitor probe, an unreadable registry (the loader's
 * action methods throw until the runtime binds) teaches nothing; the per-cell read still surfaces any error.
 */
export function promptKernelPreludes(pi: ToolRegistry): readonly KernelPreludeContribution[] {
	try {
		return activeKernelPreludes(pi);
	} catch {
		return [];
	}
}
