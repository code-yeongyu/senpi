import type { LazyToolActivator, ToolDefinition } from "./extensions/types.ts";
import { normalizeToolExposure } from "./extensions/types.ts";

interface ToolActivationHost {
	getToolDefinition(name: string): ToolDefinition | undefined;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
}

/** Activators belong to one extension generation; the host tool registry is resolved on each call. */
export class LazyToolActivation {
	readonly #host: ToolActivationHost;
	#activators: LazyToolActivator[] = [];

	constructor(host: ToolActivationHost) {
		this.#host = host;
	}

	register(activator: LazyToolActivator): void {
		this.#activators.push(activator);
	}

	reset(): void {
		this.#activators = [];
	}

	activate(toolName: string): boolean {
		const definition = this.#host.getToolDefinition(toolName);
		if (!definition) return false;
		const exposure = normalizeToolExposure(definition);
		if (!exposure.allowLazyActivation) return false;
		if (this.#activators.some((activate) => activate(toolName))) return true;
		// Search tools remain callable without a catalog extension. Eval tools never use this fallback.
		if (exposure.exposure === "search" && !this.#host.getActiveTools().includes(toolName)) {
			this.#host.setActiveTools([...this.#host.getActiveTools(), toolName]);
		}
		return this.#host.getActiveTools().includes(toolName);
	}
}
