import type { HandoverParkedEntry } from "./host-handover-parked.ts";
import type { InheritedHandover } from "./host-handover-reopen.ts";
import type { RpcCommand, RpcHostKernelMemory, RpcResponse } from "./rpc-types.ts";
import { releaseConnection } from "./session-router-attachments.ts";
import { dispose, tearDownReleased } from "./session-router-close.ts";
import { RouterContext } from "./session-router-context.ts";
import { beginDrain, sweepIdleSessions } from "./session-router-occupancy.ts";
import { reopenParked } from "./session-router-open.ts";
import { handle } from "./session-router-routing.ts";
import { authRecord } from "./rpc-auth-proof.ts";
import { classifyRpcMethod } from "./method-classes.ts";
import { ATTACH_GATE_EXEMPT } from "./session-attachment-gate.ts";

export type { RpcBindingFactory, RpcHostSessionDefaults, RpcSessionIdlePolicy } from "./session-router-types.ts";
export class SessionCommandRouter {
	private readonly context: RouterContext;
	constructor(...args: ConstructorParameters<typeof RouterContext>) {
		this.context = new RouterContext(...args);
		this.context.routes.reopen = (entry) => this.reopenParked(entry);
		this.context.releaseTeardown = (sessionId, sessionPath) => this.tearDownReleased(sessionId, sessionPath);
	}
	/** The release_session park teardown. Routed through this member, as before the split (senpi#3681). */
	private tearDownReleased(sessionId: string, sessionPath: string): Promise<boolean> {
		return tearDownReleased(this.context, sessionId, sessionPath);
	}
	get sessionCount(): number {
		return this.context.registry.size;
	}
	handle(command: RpcCommand): Promise<RpcResponse | undefined> {
		return handle(this.context, command);
	}
	configureRoutes(connection: string, record: Readonly<Record<string, unknown>>): Promise<void> {
		return this.context.routes.configure(connection, record);
	}
	/** A successor connection can attach to existing writers; it cannot create work outside them. */
	admitsRoutedRecord(connection: string, value: unknown): boolean {
		const record = authRecord(value);
		if (!record) return false;
		switch (record.type) {
			case "get_protocol_info":
			case "list_sessions":
			case "launch_proven":
			case "declare_delegation":
				return true;
			case "set_client_info":
				return (
					record.sessionId === undefined ||
					(typeof record.sessionId === "string" &&
						this.context.sessionsByConnection.get(connection)?.has(record.sessionId) === true)
				);
			case "open_session":
				return typeof record.sessionPath === "string" && typeof record.expectedHostInstance === "string";
			case "attach_session":
				return typeof record.expectedHostInstance === "string" && typeof record.durableSessionId === "string";
			case "park_session":
			case "claim_session":
			case "warm":
			case "move_session":
			case "select_hand":
			case "begin_handover":
			case "detach_connection":
			case "subscribe_sessions":
			case "unsubscribe_sessions":
			case "list_hands":
			case "find_session":
				return false;
			default:
				return (
					typeof record.sessionId === "string" &&
					(this.context.sessionsByConnection.get(connection)?.has(record.sessionId) === true ||
						this.context.handoffClosed.has(record.sessionId) ||
						(ATTACH_GATE_EXEMPT.has(record.type as RpcCommand["type"]) &&
							this.context.registry.peek(record.sessionId)?.state === "open")) &&
					classifyRpcMethod(record) !== undefined
				);
		}
	}
	beginDrain(): Promise<void> {
		return beginDrain(this.context);
	}
	setMemoryPressure(pressure: boolean): void {
		this.context.memoryPressure = pressure;
	}
	setInheritedHandover(state: InheritedHandover | undefined): void {
		this.context.awaitingPredecessorScan = false;
		this.context.inheritedHandover = state;
	}
	sweepIdleSessions(): Promise<void> {
		return sweepIdleSessions(this.context);
	}
	dispose(): Promise<void> {
		this.context.routes.dispose();
		return dispose(this.context);
	}
	reopenParked(entry: HandoverParkedEntry): Promise<RpcResponse | undefined> {
		return reopenParked(this.context, entry);
	}
	/** Whether a connection holds a session here or has an open in flight (oh-my-openagent#14272). */
	holdsSessions(connectionId: string): boolean {
		return (
			(this.context.sessionsByConnection.get(connectionId)?.size ?? 0) > 0 ||
			(this.context.opensByConnection.get(connectionId)?.size ?? 0) > 0
		);
	}
	releaseConnection(connectionId: string): Promise<string[]> {
		return releaseConnection(this.context, connectionId);
	}
	setHostMemoryView(view: {
		readonly mainHeapBytes: () => number;
		readonly kernels: () => readonly RpcHostKernelMemory[];
	}): void {
		this.context.hostMemoryView = view;
	}
}
