import type { HandoverParkedEntry } from "./host-handover-parked.ts";
import type { PredecessorPeer, RouteEndpoint } from "./predecessor-peer.ts";
import type { RpcResponse } from "./rpc-types.ts";
import type { RpcSessionRow } from "./session-registry-types.ts";
import type { RouterContext } from "./session-router-context.ts";

export interface Attachment {
	peer: Promise<PredecessorPeer>;
	count: number;
	authority?: { incarnation: number; epochOffset: number };
}
export interface Route {
	path: string;
	id: string;
	endpoint: RouteEndpoint;
	upstream?: string;
	row?: RpcSessionRow;
	generation?: number;
	switching: boolean;
	park?: HandoverParkedEntry;
	terminal?: boolean;
	/** Settles once the session is local: resolved when the reopen took it over, rejected when it cannot. */
	local: ReturnType<typeof Promise.withResolvers<void>>;
	attachments: Map<string, Attachment>;
}

/** Only sessions for which the normal registry actually found a standing foreign claim get a route. */
export class RouteTable {
	readonly byPath = new Map<string, Route>();
	readonly byId = new Map<string, Route>();
	readonly host: RouterContext;
	reopen?: (entry: HandoverParkedEntry) => Promise<RpcResponse | undefined>;
	constructor(host: RouterContext) {
		this.host = host;
	}
	holds(route: Route): boolean {
		return this.byId.get(route.id) === route;
	}
	route(path: string, endpoint: RouteEndpoint): Route {
		const existing = this.byPath.get(path);
		if (existing) return existing;
		const id = this.host.registry.reserveHandle?.();
		if (!id) throw new Error("registry_does_not_support_generation_routes");
		const route: Route = {
			path,
			id,
			endpoint,
			attachments: new Map(),
			switching: false,
			local: Promise.withResolvers<void>(),
		};
		// A switch nobody waits on may still fail; its waiters each read the outcome themselves.
		route.local.promise.catch(() => {});
		this.byPath.set(path, route);
		this.byId.set(route.id, route);
		return route;
	}
	forget(route: Route): void {
		this.byId.delete(route.id);
		this.byPath.delete(route.path);
		route.local.resolve();
	}
	dropPeer(route: Route, caller: string): void {
		const attachment = route.attachments.get(caller);
		route.attachments.delete(caller);
		void attachment?.peer.then(
			(peer) => peer.close(),
			() => {},
		);
	}
}
