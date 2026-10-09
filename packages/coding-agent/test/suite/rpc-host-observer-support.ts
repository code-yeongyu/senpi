import { ProviderScope } from "@earendil-works/pi-ai/node/provider-scope";
import type { SessionCommandRouter } from "../../src/modes/rpc/session-command-router.ts";
import type { RpcSessionEntry } from "../../src/modes/rpc/session-registry.ts";
import { RpcSessionRegistryError } from "../../src/modes/rpc/session-registry.ts";

/** Exactly the registry surface the router depends on. */
type RouterRegistry = ConstructorParameters<typeof SessionCommandRouter>[0];

/** An entry the router's occupancy sweep can inspect without a real runtime. */
export function idleEntry(lastCommandAt: number): RpcSessionEntry {
	return {
		state: "open",
		kind: "interactive",
		context: Object.freeze({}),
		scope: new ProviderScope(),
		profile: Object.freeze({ cwd: process.cwd() }),
		cwd: process.cwd(),
		attachments: 1,
		lastCommandAt,
		lifecycleMutex: Promise.resolve(),
	};
}

function unsupported(): never {
	throw new Error("the host-observer fake registry does not open sessions");
}

/**
 * Registry that knows no session: every routed command reaches `getForCommand`, which
 * reports what the dispatch looked like to the caller and then answers `unknown_session`.
 */
export function unknownSessionRegistry(onCommand: () => void): RouterRegistry {
	return {
		openSession: unsupported,
		peek: () => undefined,
		getForCommand: () => {
			onCommand();
			throw new RpcSessionRegistryError("unknown_session");
		},
		beginClose: unsupported,
		close: async () => {},
		closeMarked: async () => {},
		list: () => [],
		size: 0,
	};
}

/**
 * In-memory registry holding one open entry, recording every close the router claims.
 * Enough for the occupancy sweep, which only reads `list`/`peek` and claims a close.
 */
export function evictionRegistry(entry: RpcSessionEntry, sessionId = "rpc-1"): RouterRegistry & { closes: string[] } {
	const closes: string[] = [];
	return {
		closes,
		openSession: unsupported,
		peek: (handle) => (handle === sessionId ? entry : undefined),
		getForCommand: (handle) => {
			if (handle !== sessionId) throw new RpcSessionRegistryError("unknown_session");
			return entry;
		},
		beginClose: (handle, onRole) => {
			closes.push(handle);
			entry.state = "closing";
			entry.attachments = 0;
			onRole?.(true);
			return entry;
		},
		close: async () => {},
		closeMarked: async () => {
			entry.state = "closed";
		},
		list: () =>
			entry.state === "quarantined"
				? []
				: [
						{
							sessionId,
							cwd: entry.cwd,
							status: entry.state,
							attachments: entry.attachments,
							kind: entry.kind,
							context: entry.context,
						},
					],
		size: 1,
	};
}
