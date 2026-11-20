import { stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { echoedRoles } from "./delegation-record.ts";
import { commandAuthority } from "./command-authority.ts";
import { declareSocketClient } from "./compact-socket-commands.ts";
import { CONNECTION_ROLE_CAPABILITIES } from "./connection-roles.ts";
import { readAuthority } from "./connection-authority.ts";
import { readJsonObject } from "./host-state-json.ts";
import { type HandoverParkedEntry, readHandoverParkedSessions } from "./host-handover-parked.ts";
import { readSessionPathClaims } from "./host-reservations.ts";
import { hostGeneration } from "./protocol-identity.ts";
import { PredecessorPeer, RouteDisconnected, type RouteEndpoint, type RouteRecord } from "./predecessor-peer.ts";
import { classifyRpcMethod } from "./method-classes.ts";
import { authRecord } from "./rpc-auth-proof.ts";
import type { RpcCommand, RpcInboundRecord, RpcResponse } from "./rpc-types.ts";
import { canonicalSessionPath } from "./session-path-key.ts";
import type { RpcSessionRow } from "./session-registry-types.ts";
import { recordAttachment } from "./session-router-attachments.ts";
import { ATTACH_GATE_EXEMPT } from "./session-attachment-gate.ts";
import type { RouterContext } from "./session-router-context.ts";
import { error } from "./session-router-errors.ts";

type Open = Extract<RpcCommand, { type: "open_session" }>;
type Attach = Extract<RpcCommand, { type: "attach_session" }>;
/** The refused attach did not create a writer. Re-enter the local claim path if the park beat the attach. */
export const RETRY_ROUTED_OPEN = "retry_routed_open";
interface Attachment {
	peer: Promise<PredecessorPeer>;
	count: number;
	authority?: { incarnation: number; epochOffset: number };
}
interface Route {
	path: string;
	id: string;
	endpoint: RouteEndpoint;
	upstream?: string;
	row?: RpcSessionRow;
	generation?: number;
	switching: boolean;
	park?: HandoverParkedEntry;
	terminal?: boolean;
	local: ReturnType<typeof Promise.withResolvers<void>>;
	attachments: Map<string, Attachment>;
}

/** Only sessions for which the normal registry actually found a standing foreign claim get a route. */
export class PredecessorRoutes {
	private readonly byPath = new Map<string, Route>();
	private readonly byId = new Map<string, Route>();
	constructor(host: RouterContext) {
		this.host = host;
	}
	private readonly host: RouterContext;
	reopen?: (entry: HandoverParkedEntry) => Promise<RpcResponse | undefined>;

	handleFor(path: string | undefined): string | undefined {
		return path ? this.byPath.get(canonicalSessionPath(path))?.id : undefined;
	}
	rows(): RpcSessionRow[] {
		return Array.from(this.byId.values()).flatMap((r) =>
			r.row ? [{ ...r.row, sessionId: r.id, generation: r.generation, hostInstanceId: r.endpoint.instanceId }] : [],
		);
	}
	/** Generation-local rpc-N handles collide; a predecessor handle alone never selects a remote writer. */
	async attachByIdentity(command: Attach, refusal: RpcResponse): Promise<RpcResponse> {
		const caller = this.host.writer.currentConnection();
		if (!caller || this.host.draining || !hostGeneration(process.env)) return refusal;
		await this.discover();
		const route = [...this.byId.values()].find(
			(r) =>
				r.upstream === command.sessionId &&
				r.row?.durableSessionId === command.durableSessionId &&
				(command.expectedHostInstance === undefined || command.expectedHostInstance === r.endpoint.instanceId),
		);
		return route ? this.attach(route, caller, command) : refusal;
	}
	async attachPath(command: Open, caller: string): Promise<RpcResponse | undefined> {
		if (!command.sessionPath) return undefined;
		await this.discover();
		const route = this.byPath.get(canonicalSessionPath(command.sessionPath));
		return route && this.attach(route, caller, command);
	}
	/** Discovery is read-only: no route peer used for a list counts as an attachment or opens a runtime. */
	async discover(): Promise<void> {
		const dir = this.host.handoverParkedDir;
		const keyRoot = this.host.defaults.agentDir;
		const self = this.host.defaults.hostContext?.host_instance;
		if (
			!dir ||
			!keyRoot ||
			!self ||
			this.host.draining ||
			!hostGeneration(process.env) ||
			(!this.host.inheritedHandover?.predecessorDraining && !this.byId.size)
		)
			return;
		if ((await readJsonObject(join(dir, "host.pid")))?.instance_id !== self) return;
		const owners = new Map<string, Set<string>>();
		for (const { owner } of await readSessionPathClaims(join(dir, "reservations"))) {
			if (owner.instanceId === self || !owner.strict_transfer || !/^[a-zA-Z0-9_-]+$/.test(owner.instanceId))
				continue;
			const paths = owners.get(owner.instanceId) ?? new Set();
			paths.add(owner.sessionPath);
			owners.set(owner.instanceId, paths);
		}
		await Promise.all(
			[...owners].map(async ([instanceId, paths]) => {
				const file = await readJsonObject(join(dir, "generations", instanceId, "route.json"));
				if (typeof file?.socket !== "string" || typeof file.launchId !== "string") return;
				const endpoint = { socket: file.socket, launchId: file.launchId, instanceId, keyRoot };
				let peer: PredecessorPeer | undefined;
				try {
					peer = await PredecessorPeer.connect(
						endpoint,
						() => {},
						() => {},
					);
					const answer = await peer.request({ type: "list_sessions", include_workers: true });
					const rows = authRecord(answer.data)?.sessions;
					if (!Array.isArray(rows)) return;
					const localPaths = new Set(this.host.registry.list().map((row) => row.sessionPath));
					for (const row of rows as RpcSessionRow[]) {
						if (!row.sessionPath || row.status !== "open") continue;
						const path = canonicalSessionPath(row.sessionPath);
						if (!paths.has(path) || localPaths.has(row.sessionPath)) continue;
						const route = this.route(path, endpoint);
						route.upstream = row.sessionId;
						route.row = row;
						route.generation = peer.generation;
					}
				} catch (cause) {
					// Socket unlink and child exit race the list. A bad proof is not proof of exit.
					if (
						!(
							cause instanceof Error &&
							"code" in cause &&
							(cause.code === "ENOENT" || cause.code === "ECONNREFUSED")
						)
					)
						throw cause;
				} finally {
					peer?.close();
				}
			}),
		);
		const unclaimed = [...this.byId.values()].filter(
			(r) => !owners.get(r.endpoint.instanceId)?.has(r.path) && !r.attachments.size && !r.switching,
		);
		if (unclaimed.length) {
			const parked = new Set(
				(await readHandoverParkedSessions(dir)).map((entry) => canonicalSessionPath(entry.sessionPath)),
			);
			for (const route of unclaimed)
				if (!parked.has(route.path) && !route.attachments.size && this.byId.get(route.id) === route)
					this.forget(route);
		}
	}
	private route(path: string, endpoint: RouteEndpoint): Route {
		let route = this.byPath.get(path);
		if (route) return route;
		const id = this.host.registry.reserveHandle?.();
		if (!id) throw new Error("registry_does_not_support_generation_routes");
		route = {
			path,
			id,
			endpoint,
			attachments: new Map(),
			switching: false,
			local: Promise.withResolvers<void>(),
		};
		this.byPath.set(path, route);
		this.byId.set(route.id, route);
		return route;
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
		const path = canonicalSessionPath(command.sessionPath);
		const route = this.route(path, {
			socket: file.socket,
			launchId: file.launchId,
			instanceId: claimant.instanceId,
			keyRoot,
		});
		if (route.switching) {
			await route.local.promise;
			return RETRY_ROUTED_OPEN;
		}
		const reply = await this.attach(route, caller, command);
		if (
			!reply.success &&
			(reply.error === "session_not_held" ||
				reply.error === "session_closing" ||
				reply.error === "generation_session_parked" ||
				reply.error === "predecessor_not_sent" ||
				reply.error === "predecessor_delivery_outcome_unknown" ||
				reply.error === "generation_route_gone")
		) {
			if (route.park) {
				this.switch(route);
				await route.local.promise;
			} else await delay(25);
			return RETRY_ROUTED_OPEN;
		}
		return reply;
	}

	private connection(route: Route, caller: string): Attachment {
		const existing = route.attachments.get(caller);
		if (existing) return existing;
		const attachment: Attachment = {
			count: 0,
			peer: PredecessorPeer.connect(
				route.endpoint,
				(record) => this.receive(route, caller, record),
				() => {
					if (route.attachments.get(caller) === attachment && !route.terminal) this.switch(route);
				},
			).then(async (peer) => {
				try {
					const delegation = this.host.writer.delegations.recordOf(caller);
					if (!this.host.writer.hasConnection(caller) || route.attachments.get(caller) !== attachment)
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
					const declared = this.host.connectionRoles.rolesOf(caller, delegation?.current?.incarnation);
					const pending = this.host.pendingCapabilities.get(caller);
					// A logical detach keeps non-role preferences, never the previous incarnation's role.
					const capabilities =
						declared === undefined
							? undefined
							: [...(pending ?? []).filter((c) => !CONNECTION_ROLE_CAPABILITIES.includes(c)), ...declared];
					const remoteOrigin = this.host.connectionRoles.originOf(caller);
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

	private async attach(route: Route, caller: string, command: Open | Attach): Promise<RpcResponse> {
		const attachment = this.connection(route, caller);
		try {
			const peer = await attachment.peer;
			const reply = await peer.request({
				...command,
				...(command.type === "attach_session" ? { sessionId: route.upstream } : {}),
				expectedHostInstance: route.endpoint.instanceId,
			});
			if (reply.success !== true) {
				if (!attachment.count) this.dropPeer(route, caller);
				return { ...reply, id: command.id } as RpcResponse;
			}
			const data = authRecord(reply.data);
			if (typeof data?.sessionId !== "string") throw new Error("invalid_routed_attach");
			route.upstream = data.sessionId;
			const { routeRow, routePark, ...visible } = data;
			if (routeRow) route.row = routeRow as RpcSessionRow;
			if (routePark) route.park = routePark as HandoverParkedEntry;
			attachment.count++;
			// The watcher can finish the local reopen after A wrote its reply but before this
			// connection read it. Account for the attachment on the writer that now serves it.
			if (
				this.byId.get(route.id) !== route &&
				this.host.registry.peek(route.id)?.state === "open" &&
				this.host.writer.hasConnection(caller)
			) {
				this.host.registry.attachSession?.(route.id);
				recordAttachment(this.host, caller, route.id);
			}
			return {
				...reply,
				id: command.id,
				...(reply.sessionId === route.upstream && { sessionId: route.id }),
				data: { ...visible, sessionId: route.id },
			} as RpcResponse;
		} catch (cause) {
			if (!attachment.count) this.dropPeer(route, caller);
			if (!route.attachments.size && !route.row) this.forget(route);
			const gone =
				cause instanceof Error && "code" in cause && (cause.code === "ENOENT" || cause.code === "ECONNREFUSED");
			return error(
				command.id,
				command.type,
				gone ? "generation_route_gone" : cause instanceof Error ? cause.message : String(cause),
			);
		}
	}

	private receive(route: Route, caller: string, record: RouteRecord): void {
		if (record.sessionId !== route.upstream || !route.upstream) return;
		if (
			record.type === "session_closed" &&
			(record.reason === "handoff_parked" || record.reason === "host_shutdown")
		) {
			this.switch(route);
			return;
		}
		if (record.type === "session_closed") route.terminal = true;
		if (record.type === "response" || !this.host.writer.hasConnection(caller)) return;
		void this.host.writer.enqueueControl({ ...record, sessionId: route.id }, caller);
	}
	private switch(route: Route): void {
		if (route.switching || this.byId.get(route.id) !== route) return;
		route.switching = true;
		// The regular watch can win this race. It and this recovery path take the same registry
		// claim and attach to the same in-flight open; a broken socket never grants a write lease.
		const recover = async () => {
			while (
				!this.host.draining &&
				this.byId.get(route.id) === route &&
				this.reopen &&
				this.host.handoverParkedDir
			) {
				const records = await readHandoverParkedSessions(this.host.handoverParkedDir);
				const entry = records.find(
					(r) => r.sessionPath === route.path && r.parkedBy === route.endpoint.instanceId,
				) ??
					route.park ?? {
						sessionPath: route.path,
						durableSessionId: route.row?.durableSessionId,
						retainOnDisconnect: route.row?.retain_on_disconnect === true,
						cwd: route.row?.cwd,
					};
				if (this.byId.get(route.id) !== route) return;
				if (!(await stat(entry.sessionPath)).isFile()) throw new Error("session_file_gone");
				const result = await this.reopen({ ...entry, live: true });
				if (!result || result.success) return;
				if (result.error !== "session_path_in_use") throw new Error(result.error);
				await delay(250);
			}
		};
		void recover().catch((cause: unknown) => {
			route.local.reject(cause);
			this.forget(route);
		});
		void route.local.promise.catch(() => {});
	}

	command(
		command: RpcInboundRecord,
		local: () => Promise<RpcResponse | undefined>,
	): Promise<RpcResponse | undefined> | undefined {
		const route = "sessionId" in command && command.sessionId ? this.byId.get(command.sessionId) : undefined;
		const caller = this.host.writer.currentConnection();
		if (!route || !caller) return undefined;
		if (command.type === "set_client_info") {
			const declared = declareSocketClient(this.host, command);
			if (!declared.success) return Promise.resolve(declared);
		}
		if (route.switching)
			return route.local.promise.then(local, (cause: unknown) => error(command.id, command.type, String(cause)));
		if (command.type === "attach_session") {
			if (
				command.expectedHostInstance !== undefined &&
				command.expectedHostInstance !== this.host.defaults.hostContext?.host_instance
			)
				return Promise.resolve(error(command.id, command.type, "session_identity_mismatch"));
			return this.attach(route, caller, command);
		}
		const readOnly =
			ATTACH_GATE_EXEMPT.has(command.type as RpcCommand["type"]) && classifyRpcMethod(command) === "observe";
		const attachment = readOnly ? this.connection(route, caller) : route.attachments.get(caller);
		if (!attachment || (!readOnly && !attachment.count))
			return Promise.resolve(error(command.id, command.type, "session_not_attached"));
		return attachment.peer
			.then(async (peer) => {
				if (route.switching) {
					await route.local.promise;
					return local();
				}
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
					this.switch(route);
					await route.local.promise;
					return local();
				}
				if (
					reply.success &&
					(command.type === "close_session" || command.type === "release_attachment") &&
					--attachment.count === 0
				)
					this.dropPeer(route, caller);
				if (command.type === "close_session" && !route.attachments.size) this.forget(route);
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
					this.switch(route);
					await route.local.promise;
					return local();
				}
				return error(command.id, command.type, cause instanceof Error ? cause.message : String(cause));
			});
	}
	/** A narrowing declaration is not acknowledged until every upstream copy has installed it. */
	async configure(caller: string, record: RouteRecord): Promise<void> {
		await Promise.all(
			[...this.byId.values()].map(async (route) => {
				const attachment = route.attachments.get(caller);
				if (!attachment || route.switching) return;
				const peer = await attachment.peer;
				const reply = await peer.request(record);
				if (reply.success !== true) {
					peer.close();
					throw new Error("predecessor_configuration_refused");
				}
			}),
		);
	}

	/** Called after the ordinary reopen built the binding, before the next caller can dispatch locally. */
	adopt(id: string): void {
		const route = this.byId.get(id);
		if (!route) return;
		for (const [caller, attachment] of route.attachments) {
			if (this.host.writer.hasConnection(caller))
				for (let i = 0; i < attachment.count; i++) {
					this.host.registry.attachSession?.(id);
					recordAttachment(this.host, caller, id);
				}
			this.dropPeer(route, caller);
		}
		this.forget(route);
	}
	private forget(route: Route): void {
		this.byId.delete(route.id);
		this.byPath.delete(route.path);
		route.local.resolve();
	}
	private dropPeer(route: Route, caller: string): void {
		const attachment = route.attachments.get(caller);
		route.attachments.delete(caller);
		void attachment?.peer.then(
			(peer) => peer.close(),
			() => {},
		);
	}
	release(caller: string): void {
		for (const route of this.byId.values()) this.dropPeer(route, caller);
	}
	dispose(): void {
		for (const route of this.byId.values()) {
			for (const caller of route.attachments.keys()) this.dropPeer(route, caller);
			this.forget(route);
		}
	}
}
