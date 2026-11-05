import { createHash } from "node:crypto";
import { join } from "node:path";
import {
	type CodemodeSessionManager,
	CodemodeSessionDisposedError,
	type CreateCodemodeSessionManagerOptions,
	createCodemodeSessionManager,
} from "./session-manager.ts";

/** One execution scope (the agent's `ExecutionScope`): an opaque id minted by the loop, and its root directory. */
export interface KernelScope {
	readonly id: string;
	readonly root: string;
}

/** What belongs to one scope and cannot be shared from the runtime's options: its handles and package environments. */
export type KernelScopeOwned = Pick<CreateCodemodeSessionManagerOptions, "handles" | "environments" | "sessionEnv">;

type CreateManager = (
	options: CreateCodemodeSessionManagerOptions,
) => CodemodeSessionManager | Promise<CodemodeSessionManager>;

/** The scope id is opaque, so its directory is a digest of it, never the id itself. */
function scopeDirectory(id: string): string {
	return createHash("sha256").update(id).digest("hex").slice(0, 24);
}

function scopeOptions(
	base: CreateCodemodeSessionManagerOptions,
	scope: KernelScope,
	owned: KernelScopeOwned,
): CreateCodemodeSessionManagerOptions {
	const directory = scopeDirectory(scope.id);
	const inScope = (path: string): string => join(path, "scopes", directory);
	return {
		settings: base.settings,
		availability: base.availability,
		executeTool: base.executeTool,
		complete: base.complete,
		...(base.listTools === undefined ? {} : { listTools: base.listTools }),
		...owned,
		sessionId: scope.id,
		ownerSessionId: scope.id,
		cwd: scope.root === "" ? base.cwd : scope.root,
		...(base.artifactsDir === undefined ? {} : { artifactsDir: inScope(base.artifactsDir) }),
		...(base.localRoots === undefined
			? {}
			: {
					localRoots: Object.fromEntries(
						Object.entries(base.localRoots).map(([name, root]) => [name, inScope(root)]),
					),
				}),
	};
}

/**
 * Kernels per execution scope (brain/hand S16b): when one runtime serves several scopes, each gets its own
 * session manager, so its kernels, globals, bridge, completion context, ledgers and `local://` root are its
 * own. Releasing a scope closes exactly its kernels; the others keep running.
 */
export class ScopedKernelManagers {
	readonly #base: CreateCodemodeSessionManagerOptions;
	readonly #create: CreateManager;
	readonly #managers = new Map<string, Promise<CodemodeSessionManager>>();
	#disposed = false;

	constructor(base: CreateCodemodeSessionManagerOptions, create: CreateManager = createCodemodeSessionManager) {
		this.#base = base;
		this.#create = create;
	}

	forScope(scope: KernelScope, owned: KernelScopeOwned = {}): Promise<CodemodeSessionManager> {
		if (this.#disposed) return Promise.reject(new CodemodeSessionDisposedError());
		const existing = this.#managers.get(scope.id);
		if (existing) return existing;
		const created = Promise.resolve(this.#create(scopeOptions(this.#base, scope, owned)));
		this.#managers.set(scope.id, created);
		created.catch(() => {
			if (this.#managers.get(scope.id) === created) this.#managers.delete(scope.id);
		});
		return created;
	}

	async releaseScope(id: string): Promise<void> {
		const manager = this.#managers.get(id);
		this.#managers.delete(id);
		if (manager) await (await manager).dispose();
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		const managers = [...this.#managers.values()];
		this.#managers.clear();
		const failures: unknown[] = [];
		for (const outcome of await Promise.allSettled(managers.map(async (pending) => (await pending).dispose()))) {
			if (outcome.status === "rejected") failures.push(outcome.reason);
		}
		if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose scoped codemode kernels");
	}
}
