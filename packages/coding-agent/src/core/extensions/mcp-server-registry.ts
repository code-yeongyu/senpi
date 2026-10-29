import type { Extension, RegisteredMcpServer, RegisteredMcpServerDeclaration } from "./types.ts";

type McpRegistrar = Pick<Extension, "path" | "mcpServers">;

/**
 * The MCP servers extensions registered with `pi.registerMcpServer()`, read from the extension
 * records themselves. Until a runner binds, every loaded extension counts, in load order; once it
 * binds, only the runner's final extension set counts, in the runner's order, so an extension the
 * resource loader dropped after loading (replaced, disabled after trust, filtered) registers nothing.
 */
export class McpServerRegistry {
	readonly #loaded: McpRegistrar[] = [];
	#bound: readonly McpRegistrar[] | undefined;
	readonly #warnedClashes = new Set<string>();
	#changeListener: (() => void) | undefined;

	track(extension: McpRegistrar): void {
		this.#loaded.push(extension);
	}

	untrack(extension: McpRegistrar): void {
		const index = this.#loaded.indexOf(extension);
		if (index >= 0) this.#loaded.splice(index, 1);
	}

	/** The runner's final extension set; registrations of any other extension are no longer visible. */
	bind(extensions: readonly McpRegistrar[]): void {
		this.#bound = extensions;
	}

	/** Notify the listener (set by the runner) that an extension registered or unregistered a server. */
	changed(): void {
		this.#changeListener?.();
	}

	/** First declaration per name wins, in extension order. */
	declarations(): readonly RegisteredMcpServerDeclaration[] {
		const byName = new Map<string, RegisteredMcpServerDeclaration>();
		for (const extension of this.#bound ?? this.#loaded) {
			for (const declaration of extension.mcpServers.values()) {
				const existing = byName.get(declaration.name);
				if (existing === undefined) byName.set(declaration.name, declaration);
				else this.#warnClash(existing, declaration);
			}
		}
		return [...byName.values()];
	}

	/** Copies in upstream's `RegisteredMcpServer` shape, for extensions. */
	list(): RegisteredMcpServer[] {
		return this.declarations().map(({ name, config, extensionPath }) => ({
			name,
			config: structuredClone(config),
			extensionPath,
		}));
	}

	setChangeListener(listener: (() => void) | undefined): void {
		this.#changeListener = listener;
	}

	#warnClash(winner: RegisteredMcpServerDeclaration, loser: RegisteredMcpServerDeclaration): void {
		const key = `${winner.name}\0${winner.extensionPath}\0${loser.extensionPath}`;
		if (this.#warnedClashes.has(key)) return;
		this.#warnedClashes.add(key);
		console.warn(
			`MCP server '${winner.name}' declared by both ${winner.extensionPath} and ${loser.extensionPath}; keeping first declaration from ${winner.extensionPath}.`,
		);
	}
}
