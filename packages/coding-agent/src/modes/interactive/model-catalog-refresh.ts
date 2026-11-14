import type { ModelsRefreshResult } from "@earendil-works/pi-ai";
import { envValue } from "../../core/brand.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";

type ModelCatalogRuntime = Pick<ModelRuntime, "refresh">;

interface ActiveModelCatalogRefresh {
	controller: AbortController;
	promise: Promise<ModelsRefreshResult>;
	waiters: number;
}

class ModelCatalogRefreshCoordinator {
	private readonly activeByRuntime = new WeakMap<ModelCatalogRuntime, ActiveModelCatalogRefresh>();

	private readonly network: boolean;

	constructor(network: boolean) {
		this.network = network;
	}

	refresh(modelRuntime: ModelCatalogRuntime, signal: AbortSignal): Promise<ModelsRefreshResult> {
		signal.throwIfAborted();
		let active = this.activeByRuntime.get(modelRuntime);
		if (!active) {
			const controller = new AbortController();
			let created!: ActiveModelCatalogRefresh;
			const operation = modelRuntime.refresh(
				this.network ? { signal: controller.signal, allowNetwork: true } : { signal: controller.signal },
			);
			const promise = raceWithAbortSignal(operation, controller.signal).finally(() => {
				if (this.activeByRuntime.get(modelRuntime) === created) {
					this.activeByRuntime.delete(modelRuntime);
				}
			});
			created = { controller, promise, waiters: 0 };
			active = created;
			this.activeByRuntime.set(modelRuntime, active);
		}

		active.waiters++;
		return raceWithAbortSignal(active.promise, signal).finally(() => {
			active.waiters--;
			if (active.waiters === 0 && this.activeByRuntime.get(modelRuntime) === active) {
				active.controller.abort();
			}
		});
	}
}

const offlineCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator(false);
const networkCatalogRefreshCoordinator = new ModelCatalogRefreshCoordinator(true);

/**
 * Share concurrent interactive all-catalog refreshes while keeping each caller's cancellation independent.
 * Runs under the runtime's own network policy, which is offline for session runtimes (startup path).
 */
export function refreshModelCatalogs(
	modelRuntime: ModelCatalogRuntime,
	signal: AbortSignal,
): Promise<ModelsRefreshResult> {
	return offlineCatalogRefreshCoordinator.refresh(modelRuntime, signal);
}

/**
 * A refresh the user explicitly asked for (opening `/model`, `/model <term>`, the scoped-model picker):
 * fetch provider catalogs over the network, unless OFFLINE is set. Without this, a credentialed provider
 * whose stored catalog is empty (for example Ollama with only an env key) never lists a model (senpi#839).
 */
export function refreshModelCatalogsOnRequest(
	modelRuntime: ModelCatalogRuntime,
	signal: AbortSignal,
	env: NodeJS.ProcessEnv = process.env,
): Promise<ModelsRefreshResult> {
	const coordinator =
		envValue("OFFLINE", env) === undefined ? networkCatalogRefreshCoordinator : offlineCatalogRefreshCoordinator;
	return coordinator.refresh(modelRuntime, signal);
}

/** Name each provider that failed to refresh together with its last error, so the cause is visible. */
export function describeModelRefreshErrors(errors: ReadonlyMap<string, Error>): string | undefined {
	if (errors.size === 0) return undefined;
	const lines = [...errors].map(([providerId, error]) => `${providerId}: ${error.message}`);
	const head =
		errors.size === 1
			? `Could not refresh ${lines[0]}`
			: `Could not refresh ${errors.size} model catalogs:\n${lines.map((line) => `  ${line}`).join("\n")}`;
	return `${head}\nShowing cached models; reopen /model to retry.`;
}
