import type { KernelPreludeContribution } from "./types.ts";

/** Helpers every eval kernel (JavaScript and Python) installs before any contribution runs. */
const KERNEL_BUILTIN_GLOBALS: ReadonlySet<string> = new Set([
	"agent",
	"completion",
	"display",
	"env",
	"log",
	"output",
	"parallel",
	"phase",
	"pipeline",
	"print",
	"read",
	"tool",
	"tool_schema",
	"tools",
	"workpool",
	"write",
]);

export class KernelPreludeCollisionError extends Error {
	readonly name = "KernelPreludeCollisionError";
	readonly toolName: string;
	readonly collidingExport: string;

	constructor(toolName: string, collidingExport: string) {
		super(
			`Tool "${toolName}" kernelPrelude export "${collidingExport}" collides with a built-in eval kernel global.`,
		);
		this.toolName = toolName;
		this.collidingExport = collidingExport;
	}
}

/**
 * The `kernelPrelude` a tool projects through `getAllTools()`. Throws when an export would shadow a built-in kernel
 * helper or a `__`-prefixed kernel internal, since installing it would break every later cell.
 */
export function projectKernelPrelude(
	toolName: string,
	prelude: KernelPreludeContribution | undefined,
): KernelPreludeContribution | undefined {
	const collision = prelude?.exports.find((name) => KERNEL_BUILTIN_GLOBALS.has(name) || name.startsWith("__"));
	if (collision !== undefined) throw new KernelPreludeCollisionError(toolName, collision);
	return prelude;
}
