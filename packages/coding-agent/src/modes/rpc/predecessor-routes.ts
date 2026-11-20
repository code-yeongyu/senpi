import { join } from "node:path";
import { commandAuthority } from "./command-authority.ts";
import { declareSocketClient } from "./compact-socket-commands.ts";
import { readJsonObject } from "./host-state-json.ts";
import type { HandoverParkedEntry } from "./host-handover-parked.ts";
import { hostGeneration } from "./protocol-identity.ts";
import { type Attach, attach, connection, type Open } from "./predecessor-attach.ts";
import { discoverRoutes } from "./predecessor-discovery.ts";
import { RouteDisconnected, type RouteRecord } from "./predecessor-peer.ts";
import { type Route, RouteTable } from "./predecessor-route-table.ts";
import { afterSwitch, awaitSwitch, switchRoute } from "./predecessor-switch.ts";
import { classifyRpcMethod } from "./method-classes.ts";
import { authRecord } from "./rpc-auth-proof.ts";
import type { RpcCommand, RpcInboundRecord, RpcResponse } from "./rpc-types.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import type { RpcSessionRow } from "./session-registry-types.ts";
import { recordAttachment } from "./session-router-attachments.ts";
import { ATTACH_GATE_EXEMPT } from "./session-attachment-gate.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

/** The refused attach did not create a writer. Re-enter the local claim path if the park beat the attach. */
export const RETRY_ROUTED_OPEN = "retry_routed_open";
const ROUTE_GONE_ERRORS: readonly unknown[] = [
	"session_not_held",
	"session_closing",
	"generation_session_parked",
	"predecessor_not_sent",
	"predecessor_delivery_outcome_unknown",
	"generation_route_gone",
];

/** A successor's routes to the sessions its draining predecessor still runs (senpi#7098). */
export class PredecessorRoutes {
	private readonly table: RouteTable;
	constructor(host: RouterContext) {
		this.table = new RouteTable(host);
	}
	private get host(): RouterContext {
		return this.table.host;
	}
	set reopen(reopen: (entry: HandoverParkedEntry) => Promise<RpcResponse | undefined>) {
		this.table.reopen = reopen;
	}

	handleFor(path: string | undefined): string | undefined {
		return path ? this.table.byPath.get(canonicalSessionPath(path))?.id : undefined;
	}
	rows(): RpcSessionRow[] {
		return Array.from(this.table.byId.values()).flatMap((r) =>
			r.row ? [{ ...r.row, sessionId: r.id, generation: r.generation, hostInstanceId: r.endpoint.instanceId }] : [],
		);
	}
	discover(): Promise<void> {
		return discoverRoutes(this.table);
	}
	/** Generation-local rpc-N handles collide; a predecessor handle alone never selects a remote writer. */
	async attachByIdentity(command: Attach, refusal: RpcResponse): Promise<RpcResponse> {
		const caller = this.host.writer.currentConnection();
		if (!caller || this.host.draining || !hostGeneration(process.env)) return refusal;
		await this.discover();
		const route = [...this.table.byId.values()].find(
			(r) =>
				r.upstream === command.sessionId &&
				r.row?.durableSessionId === command.durableSessionId &&
				(command.expectedHostInstance === undefined || command.expectedHostInstance === r.endpoint.instanceId),
		);
		return route ? attach(this.table, route, caller, command) : refusal;
	}
	async attachPath(command: Open, caller: string): Promise<RpcResponse | undefined> {
		if (!command.sessionPath) return undefined;
		await this.discover();
		const route = this.table.byPath.get(canonicalSessionPath(command.sessionPath));
		return route && attach(this.table, route, caller, command);
	}

	async open(
		command: Open,
		caller: string,
		detail: Readonly<Record<string, unknown>> | undefined,
	): Promise<RpcResponse | typeof RETRY_ROUTED_OPEN | undefined> {
		const claimant = authRecord(detail?.owner);
		const dir = this.host.handoverParkedDir;
		const keyRoot = this.host.defaults.agentDir;
		if (
			!command.sessionPath ||
			!dir ||
			!keyRoot ||
			claimant?.strict_transfer !== true ||
			claimant.current !== false ||
			typeof claimant.instanceId !== "string" ||
			!/^[a-zA-Z0-9_-]+$/.test(claimant.instanceId)
		)
			return undefined;
		const file = await readJsonObject(join(dir, "generations", claimant.instanceId, "route.json"));
		if (!file || typeof file.socket !== "string" || typeof file.launchId !== "string") return undefined;
		if ((await readJsonObject(join(dir, "host.pid")))?.instance_id !== this.host.defaults.hostContext?.host_instance)
			return undefined;
		const route = this.table.route(canonicalSessionPath(command.sessionPath), {
			socket: file.socket,
			launchId: file.launchId,
			instanceId: claimant.instanceId,
			keyRoot,
		});
		if (route.switching) return this.retryAfterSwitch(route, command);
		const reply = await attach(this.table, route, caller, command);
		if (reply.success || !ROUTE_GONE_ERRORS.includes(reply.error)) return reply;
		if (!route.park) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			return RETRY_ROUTED_OPEN;
		}
		switchRoute(this.table, route);
		return this.retryAfterSwitch(route, command);
	}
	/** A pending switch is retried: the open itself stops retrying once the close grace window has passed. */
	private async retryAfterSwitch(route: Route, command: Open): Promise<RpcResponse | typeof RETRY_ROUTED_OPEN> {
		const outcome = await awaitSwitch(this.table, route);
		return outcome.kind === "failed" ? error(command.id, command.type, outcome.code) : RETRY_ROUTED_OPEN;
	}

	command(
		command: RpcInboundRecord,
		local: () => Promise<RpcResponse | undefined>,
	): Promise<RpcResponse | undefined> | undefined {
		const route = "sessionId" in command && command.sessionId ? this.table.byId.get(command.sessionId) : undefined;
		const caller = this.host.writer.currentConnection();
		if (!route || !caller) return undefined;
		if (command.type === "set_client_info") {
			const declared = declareSocketClient(this.host, command);
			if (!declared.success) return Promise.resolve(declared);
		}
		if (route.switching) return afterSwitch(this.table, route, command, local);
		if (command.type === "attach_session") {
			if (
				command.expectedHostInstance !== undefined &&
				command.expectedHostInstance !== this.host.defaults.hostContext?.host_instance
			)
				return Promise.resolve(error(command.id, command.type, "session_identity_mismatch"));
			return attach(this.table, route, caller, command);
		}
		const readOnly =
			ATTACH_GATE_EXEMPT.has(command.type as RpcCommand["type"]) && classifyRpcMethod(command) === "observe";
		const attachment = readOnly ? connection(this.table, route, caller) : route.attachments.get(caller);
		if (!attachment || (!readOnly && !attachment.count))
			return Promise.resolve(error(command.id, command.type, "session_not_attached"));
		return attachment.peer
			.then(async (peer) => {
				if (route.switching) return afterSwitch(this.table, route, command, local);
				const wire = { ...command, sessionId: route.upstream, relayExec: commandAuthority.getStore()?.exec };
				// UI answers are notifications: `id` names the question on the predecessor, not a response slot.
				if (
					wire.type === "extension_ui_response" ||
					wire.type === "extension_ui_progress" ||
					wire.type === "host_response"
				) {
					peer.send(wire);
					return undefined;
				}
				const reply = await peer.request(wire);
				if (reply.success === false && reply.error === "generation_session_parked") {
					switchRoute(this.table, route);
					return afterSwitch(this.table, route, command, local);
				}
				if (
					reply.success &&
					(command.type === "close_session" || command.type === "release_attachment") &&
					--attachment.count === 0
				)
					this.table.dropPeer(route, caller);
				if (command.type === "close_session" && !route.attachments.size) this.table.forget(route);
				const payload = authRecord(reply.data);
				const receipt = authRecord(reply.authority);
				return {
					...reply,
					...(attachment.authority &&
						typeof receipt?.epoch === "number" && {
							authority: {
								...receipt,
								incarnation: attachment.authority.incarnation,
								epoch: receipt.epoch + attachment.authority.epochOffset,
							},
						}),
					id: command.id,
					...(reply.sessionId !== undefined && { sessionId: route.id }),
					...(payload?.sessionId === route.upstream && { data: { ...payload, sessionId: route.id } }),
				} as RpcResponse;
			})
			.catch(async (cause: unknown) => {
				// Never replay an unacknowledged mutation: the old writer may have committed it.
				if (cause instanceof RouteDisconnected && (!cause.sent || classifyRpcMethod(command) === "observe")) {
					switchRoute(this.table, route);
					return afterSwitch(this.table, route, command, local);
				}
				return error(command.id, command.type, cause instanceof Error ? cause.message : String(cause));
			});
	}
	/**
	 * A narrowing declaration is not acknowledged until every upstream copy has installed it. A copy that refuses it or
	 * does not answer is cut instead (its route switches to a local reopen), so the declaration holds everywhere and its
	 * reply is never held by a predecessor.
	 */
	async configure(caller: string, record: RouteRecord): Promise<void> {
		await Promise.all(
			[...this.table.byId.values()].map(async (route) => {
				const attachment = route.attachments.get(caller);
				if (!attachment || route.switching) return;
				// A copy whose setup failed holds nothing upstream; its peer is already closed.
				const peer = await attachment.peer.catch(() => undefined);
				if (!peer) return;
				const installed = await peer.request(record).then(
					(reply) => reply.success === true,
					() => false,
				);
				if (!installed) peer.close();
			}),
		);
	}

	/** Called after the ordinary reopen built the binding, before the next caller can dispatch locally. */
	adopt(id: string): void {
		const route = this.table.byId.get(id);
		if (!route) return;
		for (const [caller, attachment] of route.attachments) {
			if (this.host.writer.hasConnection(caller))
				for (let i = 0; i < attachment.count; i++) {
					this.host.registry.attachSession?.(id);
					recordAttachment(this.host, caller, id);
				}
			this.table.dropPeer(route, caller);
		}
		this.table.forget(route);
	}
	release(caller: string): void {
		for (const route of this.table.byId.values()) this.table.dropPeer(route, caller);
	}
	dispose(): void {
		for (const route of this.table.byId.values()) {
			for (const caller of route.attachments.keys()) this.table.dropPeer(route, caller);
			this.table.forget(route);
		}
	}
}
