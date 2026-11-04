import type { ScopeLifecycle } from "@earendil-works/pi-agent-core/conformance";
import { toStoreValue } from "./executor-freeze.ts";

export class LifecycleRefusedError extends Error {
	readonly reason: string;
	constructor(kind: string, reason: string) {
		super(`lifecycle event ${kind} refused: ${reason}`);
		this.name = "LifecycleRefusedError";
		this.reason = reason;
	}
}

/**
 * One session's lifecycle on a split endpoint (design 5.6.6): an extension lifecycle handler (`agent_end`,
 * `turn_start`, ...) runs through the scope so its effect commits before the event is admitted, and every tool call
 * goes through `call`, so a call issued after the event runs only after that commit.
 */
export function createLifecycleBridge(options: {
	readonly scopes: ScopeLifecycle;
	readonly issuer: string;
	readonly scope: string;
}) {
	const { scopes, issuer, scope } = options;
	return {
		event: async (kind: string, handler: () => Promise<unknown>): Promise<number> => {
			const admitted = await scopes.lifecycle(issuer, scope, kind, async () =>
				toStoreValue((await handler()) ?? null),
			);
			if (admitted.kind === "refused") throw new LifecycleRefusedError(kind, admitted.reason);
			return admitted.seq;
		},
		call: <T>(run: () => Promise<T>): Promise<T> => scopes.call(scope, run),
	};
}
