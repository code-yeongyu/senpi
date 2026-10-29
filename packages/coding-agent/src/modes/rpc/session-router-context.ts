import { subscriptionLimits } from "../../core/subscription-limits/limit-store.ts";

import { ConnectionRoles } from "./connection-roles.ts";
import { latestSessionEffect } from "./effect-ledger.ts";

import type { RpcHostKernelMemory } from "./rpc-types.ts";

import { createRpcSessionBinding, type RpcSessionBinding } from "./session-binding.ts";

import { drainSessionEffects, installSessionEffectSink } from "./session-effect-status.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";

import type { RpcSessionRegistry } from "./session-registry.ts";
import { SessionAttachOrder } from "./session-attach-order.ts";
import { tearDownReleased } from "./session-router-close.ts";
import { routingIdOf } from "./session-router-errors.ts";
import { sweepIdleSessions } from "./session-router-occupancy.ts";
import type { RpcHostSessionDefaults, RpcSessionIdlePolicy } from "./session-router-types.ts";
import { registryStatusSource } from "./session-status-source.ts";
export class RouterContext {
	readonly bindings = new Map<string, RpcSessionBinding>();

	readonly stopLimitBroadcast: () => void;

	/** Session handles opened by each connection, with one count per attachment. */
	readonly sessionsByConnection = new Map<string, Map<string, number>>();

	/** When each connection first attached to each session: relocation asks the earliest offerer (senpi#3994). */
	readonly attachOrder = new SessionAttachOrder();

	/** Opens currently awaiting runtime/binding setup, keyed by connection. */
	readonly opensByConnection = new Map<string, Set<Promise<void>>>();

	/** Connections whose socket has already been detached. */
	readonly releasedConnections = new Set<string>();

	readonly registry: Pick<
		RpcSessionRegistry,
		"openSession" | "peek" | "getForCommand" | "beginClose" | "close" | "closeMarked" | "list" | "size" | "warm"
	> &
		Partial<Pick<RpcSessionRegistry, "holderPids" | "attachSession" | "agentDir">>;

	readonly writer: SessionEventWriter;

	readonly defaults: RpcHostSessionDefaults;

	readonly createBinding: typeof createRpcSessionBinding;

	readonly connectionOptions: Parameters<typeof createRpcSessionBinding>[4];

	readonly pendingCapabilities = new Map<string, string[]>();
	/** Roles each connection declared through set_client_info (senpi#3811). */
	readonly connectionRoles = new ConnectionRoles();

	readonly finalizations = new Map<string, { promise: Promise<void>; resolve: () => void }>();

	readonly idleNow: () => number;

	readonly idleEvictionMs: number;

	readonly emptyExitMs: number;

	readonly onEmptyExit?: () => void;

	readonly canExitWhenEmpty?: () => boolean;

	sweepTimer: ReturnType<typeof setInterval> | undefined;

	uninstallEffectSink: (() => void) | undefined;

	drainTimer: ReturnType<typeof setInterval> | undefined;

	draining = false;

	handoffParks = 0;

	drainExitRequested = false;

	readonly handoffClosed = new Set<string>();

	/** Sessions whose automatic turns this draining generation already held (senpi#3114, `session-drain-hold.ts`). */
	readonly drainHeldSessions = new Set<string>();

	readonly activeRequests = new Map<string | undefined, number>();

	/** Called after any request for that session settles; a release waits here for the others to finish. */
	readonly requestSettledListeners = new Map<string, Set<() => void>>();

	readonly onHandoffParked?: RpcSessionIdlePolicy["onHandoffParked"];

	readonly handoverParkedDir?: string;

	emptySince: number | undefined;

	/** Halves the idle window while the host reports memory pressure; never refuses work. */
	memoryPressure = false;

	/** The release_session teardown; the router installs its own member here, so it owns the step. */
	releaseTeardown = (sessionId: string, sessionPath: string): Promise<boolean> =>
		tearDownReleased(this, sessionId, sessionPath);

	/** Live kernel view the host injects; absent until start, and a session with no kernel reads zeros. */
	hostMemoryView:
		| { readonly mainHeapBytes: () => number; readonly kernels: () => readonly RpcHostKernelMemory[] }
		| undefined;

	constructor(
		registry: Pick<
			RpcSessionRegistry,
			"openSession" | "peek" | "getForCommand" | "beginClose" | "close" | "closeMarked" | "list" | "size" | "warm"
		> &
			Partial<Pick<RpcSessionRegistry, "holderPids" | "attachSession" | "agentDir">>,
		writer: SessionEventWriter,
		defaults: RpcHostSessionDefaults,
		createBinding: typeof createRpcSessionBinding = createRpcSessionBinding,
		connectionOptions: Parameters<typeof createRpcSessionBinding>[4] = {},
		idle?: RpcSessionIdlePolicy,
	) {
		// Every connection hears an account's new limit windows, whichever session's request reported them.
		this.stopLimitBroadcast = subscriptionLimits.subscribe((limits) =>
			writer.broadcastHostRecord({ type: "subscription_limits", ...limits }),
		);
		this.registry = registry;
		this.writer = writer;
		this.defaults = defaults;
		this.createBinding = createBinding;
		this.connectionOptions = connectionOptions;
		this.idleNow = idle?.now ?? Date.now;
		this.idleEvictionMs = idle?.idleEvictionMs ?? Number.POSITIVE_INFINITY;
		this.emptyExitMs = idle?.emptyExitMs ?? Number.POSITIVE_INFINITY;
		this.onEmptyExit = idle?.onEmptyExit;
		this.onHandoffParked = idle?.onHandoffParked;
		this.handoverParkedDir = idle?.handoverParkedDir;
		this.canExitWhenEmpty = idle?.canExitWhenEmpty;
		writer.status.setSource(registryStatusSource(registry));
		writer.status.setLastEffectProvider((sessionId) => {
			const session = this.registry.peek(sessionId)?.runtime?.session;
			if (session === undefined) return undefined;
			const latest = latestSessionEffect(session);
			return latest === undefined
				? undefined
				: { effectId: latest.effectId, kind: latest.kind, state: latest.state };
		});
		writer.afterRecord = (sessionId) => {
			const session = this.registry.peek(sessionId)?.runtime?.session;
			if (session === undefined) return;
			for (const status of drainSessionEffects(session)) this.writer.status.publishEffect(sessionId, status);
		};
		this.uninstallEffectSink = installSessionEffectSink({
			owns: (session) => routingIdOf(this, session) !== undefined,
			flush: (session, statuses) => {
				const sessionId = routingIdOf(this, session);
				if (sessionId === undefined) return;
				for (const status of statuses) this.writer.status.publishEffect(sessionId, status);
			},
		});
		if (Number.isFinite(this.idleEvictionMs) || Number.isFinite(this.emptyExitMs)) {
			// Unref'd: occupancy hygiene must never be the reason the event loop stays open.
			const tickMs = Math.max(20, Math.min(5_000, Math.min(this.idleEvictionMs, this.emptyExitMs) / 4));
			this.sweepTimer = setInterval(() => sweepIdleSessions(this), tickMs);
			this.sweepTimer.unref?.();
		}
	}
}
