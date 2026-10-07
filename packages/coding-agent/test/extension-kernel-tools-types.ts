/**
 * Compile-only fixture: `ExtensionContext.kernelTools` must match the shipped
 * kernel-tools surface (invoke scope options + capabilities.invokeScope).
 */
import type { ExtensionContext } from "../src/core/extensions/types.ts";

const request = {
	name: "fn",
	kernel_generation: 0,
	definition_revision: 0,
	args: {},
	call_id: "call",
};

export function assertShippedKernelToolsSurface(ctx: ExtensionContext): void {
	const kernelTools = ctx.kernelTools;
	if (!kernelTools) return;
	void kernelTools.invoke(request, { scope: { tools: { deny: ["write"] } } });
	void kernelTools.invoke(request, AbortSignal.abort());
	const invokeScope: boolean = kernelTools.capabilities.invokeScope;
	void invokeScope;
}
