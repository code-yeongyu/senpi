import type { HandoverParkedEntry } from "./host-handover-parked.ts";
import type { RpcCommand, RpcHostKernelMemory, RpcResponse } from "./rpc-types.ts";
import { releaseConnection } from "./session-router-attachments.ts";
import { dispose, tearDownReleased } from "./session-router-close.ts";
import { RouterContext } from "./session-router-context.ts";
import { beginDrain, sweepIdleSessions } from "./session-router-occupancy.ts";
import { reopenParked } from "./session-router-open.ts";
import { handle } from "./session-router-routing.ts";

export type { RpcBindingFactory, RpcHostSessionDefaults, RpcSessionIdlePolicy } from "./session-router-types.ts";
export class SessionCommandRouter {
	private readonly context: RouterContext;
	constructor(...args: ConstructorParameters<typeof RouterContext>) {
		this.context = new RouterContext(...args);
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
	beginDrain(): void {
		beginDrain(this.context);
	}
	setMemoryPressure(pressure: boolean): void {
		this.context.memoryPressure = pressure;
	}
	sweepIdleSessions(): void {
		sweepIdleSessions(this.context);
	}
	dispose(): Promise<void> {
		return dispose(this.context);
	}
	reopenParked(entry: HandoverParkedEntry): Promise<RpcResponse | undefined> {
		return reopenParked(this.context, entry);
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
