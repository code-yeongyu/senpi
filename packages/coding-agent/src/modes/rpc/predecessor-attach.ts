import { echoedRoles } from "./delegation-record.ts";
import { commandAuthority } from "./command-authority.ts";
import { CONNECTION_ROLE_CAPABILITIES } from "./connection-roles.ts";
import { readAuthority } from "./connection-authority.ts";
import { PredecessorPeer, type RouteRecord } from "./predecessor-peer.ts";
import type { Attachment, Route, RouteTable } from "./predecessor-route-table.ts";
import { switchRoute } from "./predecessor-switch.ts";
import { routedAttachExtras } from "./predecessor-wire.ts";
import { authRecord } from "./rpc-auth-proof.ts";
import type { RpcCommand, RpcResponse } from "./rpc-types.ts";
import { recordAttachment } from "./session-router-attachments.ts";
import { error } from "./session-router-errors.ts";

export type Open = Extract<RpcCommand, { type: "open_session" }>;
export type Attach = Extract<RpcCommand, { type: "attach_session" }>;

export function connection(table: RouteTable, route: Route, caller: string): Attachment {
	const existing = route.attachments.get(caller);
	if (existing) return existing;
	const host = table.host;
	const attachment: Attachment = {
		count: 0,
		peer: PredecessorPeer.connect(
			route.endpoint,
			(record) => receive(table, route, caller, record),
			() => {
				if (route.attachments.get(caller) === attachment && !route.terminal) switchRoute(table, route);
			},
		).then(async (peer) => {
			try {
				const delegation = host.writer.delegations.recordOf(caller);
				if (!host.writer.hasConnection(caller) || route.attachments.get(caller) !== attachment)
					throw new Error("connection_closed");
				if (delegation) {
					if (delegation.closed || delegation.current?.incarnation !== commandAuthority.getStore()?.incarnation)
						throw new Error("delegation_incarnation_stale");
					if (delegation.current)
						attachment.authority = {
							incarnation: delegation.current.incarnation,
							epochOffset: readAuthority(delegation.current.authority).epoch - 1,
						};
					const reply = await peer.request({
						type: "declare_delegation",
						principal: delegation.principal,
						granted: [...delegation.granted],
						...echoedRoles(delegation),
					});
					if (!reply.success) throw new Error("delegation_refused");
				}
				const declared = host.connectionRoles.rolesOf(caller, delegation?.current?.incarnation);
				const pending = host.pendingCapabilities.get(caller);
				// A logical detach keeps non-role preferences, never the previous incarnation's role.
				const capabilities =
					declared === undefined
						? undefined
						: [...(pending ?? []).filter((c) => !CONNECTION_ROLE_CAPABILITIES.includes(c)), ...declared];
				const remoteOrigin = host.connectionRoles.originOf(caller);
				if (capabilities || remoteOrigin) {
					const reply = await peer.request({ type: "set_client_info", capabilities, remoteOrigin });
					if (!reply.success) throw new Error("routed_client_declaration_refused");
				}
				route.generation = peer.generation;
				return peer;
			} catch (cause) {
				peer.close();
				throw cause;
			}
		}),
	};
	route.attachments.set(caller, attachment);
	return attachment;
}

export async function attach(
	table: RouteTable,
	route: Route,
	caller: string,
	command: Open | Attach,
): Promise<RpcResponse> {
	const host = table.host;
	const attachment = connection(table, route, caller);
	try {
		const peer = await attachment.peer;
		const reply = await peer.request({
			...command,
			...(command.type === "attach_session" ? { sessionId: route.upstream } : {}),
			expectedHostInstance: route.endpoint.instanceId,
		});
		if (reply.success !== true) {
			if (!attachment.count) table.dropPeer(route, caller);
			return { ...reply, id: command.id } as RpcResponse;
		}
		const data = authRecord(reply.data);
		if (typeof data?.sessionId !== "string") throw new Error("invalid_routed_attach");
		route.upstream = data.sessionId;
		const { routeRow: _row, routePark: _park, ...visible } = data;
		const extras = routedAttachExtras(data);
		if (extras.row) route.row = extras.row;
		if (extras.park) route.park = extras.park;
		attachment.count++;
		// The watcher can finish the local reopen after A wrote its reply but before this
		// connection read it. Account for the attachment on the writer that now serves it.
		if (!table.holds(route) && host.registry.peek(route.id)?.state === "open" && host.writer.hasConnection(caller)) {
			host.registry.attachSession?.(route.id);
			recordAttachment(host, caller, route.id);
		}
		return {
			...reply,
			id: command.id,
			...(reply.sessionId === route.upstream && { sessionId: route.id }),
			data: { ...visible, sessionId: route.id },
		} as RpcResponse;
	} catch (cause) {
		if (!attachment.count) table.dropPeer(route, caller);
		if (!route.attachments.size && !route.row) table.forget(route);
		const gone =
			cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ECONNREFUSED");
		return error(
			command.id,
			command.type,
			gone ? "generation_route_gone" : cause instanceof Error ? cause.message : String(cause),
		);
	}
}

function receive(table: RouteTable, route: Route, caller: string, record: RouteRecord): void {
	if (record.sessionId !== route.upstream || !route.upstream) return;
	if (record.type === "session_closed" && (record.reason === "handoff_parked" || record.reason === "host_shutdown")) {
		switchRoute(table, route);
		return;
	}
	if (record.type === "session_closed") route.terminal = true;
	if (record.type === "response" || !table.host.writer.hasConnection(caller)) return;
	void table.host.writer.enqueueControl({ ...record, sessionId: route.id }, caller);
}
