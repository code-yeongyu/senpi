import type { AgentSessionEvent } from "../../../core/agent-session.ts";
import type {
	JsonValue,
	ThreadId,
	TurnInterruptParams,
	TurnInterruptResponse,
	TurnStartParams,
	TurnStartResponse,
	TurnSteerParams,
	TurnSteerResponse,
} from "../protocol/index.ts";
import { EventProjector } from "./projection.ts";
import type { ProjectedNotification } from "./projection-types.ts";
import type { TurnLog, WireItem } from "./turn-log.ts";
import {
	buildTurn,
	buildUserMessage,
	createTurnId,
	invalidRequest,
	type LoggedStartStatus,
	type PendingTurn,
	parseInput,
	readLoggedItems,
	type TurnEngineApi,
	type TurnEngineNotification,
	type TurnEngineOptions,
	type TurnEngineSessionEvent,
	type TurnEngineStore,
	type TurnEngineThreadEntry,
	type TurnWireStatus,
	toTurnEngineError,
	wireItemToJson,
} from "./turn-runtime.ts";

export {
	type TurnEngineApi,
	TurnEngineError,
	type TurnEngineNotification,
	type TurnEngineOptions,
	type TurnEngineSession,
	type TurnEngineSessionEvent,
	type TurnEngineStore,
	type TurnEngineThreadEntry,
	type TurnEngineThreadStatus,
} from "./turn-runtime.ts";

export function createTurnEngine<Entry extends TurnEngineThreadEntry = TurnEngineThreadEntry>(
	options: TurnEngineOptions<Entry>,
): TurnEngineApi {
	return new TurnEngine(options);
}

class TurnEngine<Entry extends TurnEngineThreadEntry> {
	private readonly store: TurnEngineStore<Entry>;
	private readonly turnLog: TurnLog;
	private readonly emitToThread: (threadId: string, notification: TurnEngineNotification) => void;
	private readonly broadcast: (notification: TurnEngineNotification) => void;
	private readonly pendingByThreadId = new Map<ThreadId, PendingTurn>();
	private readonly subscribedThreadIds = new Set<ThreadId>();
	private readonly projectorByThreadId = new Map<
		ThreadId,
		{ readonly turnId: string; readonly projector: EventProjector }
	>();

	constructor(options: TurnEngineOptions<Entry>) {
		this.store = options.store;
		this.turnLog = options.turnLog;
		this.emitToThread = options.emitToThread;
		this.broadcast = options.broadcast;
	}

	startTurn(params: TurnStartParams): Promise<TurnStartResponse> {
		this.getLoadedThreadOrThrow(params.threadId);

		let didSettle = false;
		const accepted = new Promise<TurnStartResponse>((resolve, reject) => {
			const run = this.store.runThreadTask(params.threadId, async () => {
				try {
					const parsedInput = parseInput(params.input);
					const entry = this.getLoadedThreadOrThrow(params.threadId);
					this.ensureSessionSubscription(params.threadId, entry);
					const turnId = createTurnId();
					const startedAtMs = Date.now();
					const startedAt = new Date(startedAtMs).toISOString();
					const turn = buildTurn(turnId, "inProgress", startedAtMs, null, []);
					const userMessage = buildUserMessage(params.clientUserMessageId ?? null, parsedInput.content);

					entry.activeTurn = { turnId, startedAt };
					entry.status = "active";
					entry.updatedAt = startedAt;
					this.turnLog.recordTurn(params.threadId, {
						turnId,
						startedAt,
						status: "running" satisfies LoggedStartStatus,
					});
					this.emitToThread(params.threadId, {
						method: "turn/started",
						params: { threadId: params.threadId, turn },
					});
					this.emitUserMessage(params.threadId, turnId, startedAtMs, userMessage);

					let pendingTurn: PendingTurn;
					const completion = new Promise<void>((complete) => {
						pendingTurn = {
							turnId,
							startedAt,
							startedAtMs,
							resolve: complete,
							interrupted: false,
							completed: false,
						};
						this.pendingByThreadId.set(params.threadId, pendingTurn);
					});

					void entry.session
						.prompt(parsedInput.text, {
							source: "rpc",
							preflightResult: (success) => {
								if (success) {
									if (!didSettle) {
										didSettle = true;
										resolve({ turn });
									}
									return;
								}
								if (!pendingTurn.completed) {
									this.completeTurn(params.threadId, "failed", "Prompt preflight failed");
								}
							},
						})
						.then(() => {
							if (!didSettle) {
								didSettle = true;
								reject(toTurnEngineError(new Error("Prompt preflight failed")));
							}
						})
						.catch((error: unknown) => {
							if (!didSettle) {
								didSettle = true;
								reject(toTurnEngineError(error));
							}
							this.completeTurn(
								params.threadId,
								"failed",
								error instanceof Error ? error.message : String(error),
							);
						});
					await completion;
				} catch (error) {
					if (!didSettle) {
						didSettle = true;
						reject(toTurnEngineError(error instanceof Error ? error : new Error(String(error))));
					}
				}
			});
			run.catch((error: unknown) => {
				if (!didSettle) {
					didSettle = true;
					reject(toTurnEngineError(error));
				}
			});
		});

		return accepted;
	}

	async steerTurn(params: TurnSteerParams): Promise<TurnSteerResponse> {
		const entry = this.getLoadedThreadOrThrow(params.threadId);
		const activeTurn = entry.activeTurn;
		if (!activeTurn) {
			throw invalidRequest(`No active turn for thread ${params.threadId}`);
		}
		if (activeTurn.turnId !== params.expectedTurnId) {
			throw invalidRequest(
				`Turn id mismatch: expected ${params.expectedTurnId} but active turn is ${activeTurn.turnId}`,
			);
		}
		const parsedInput = parseInput(params.input);
		await entry.session.steer(parsedInput.text);
		this.emitUserMessage(
			params.threadId,
			activeTurn.turnId,
			Date.now(),
			buildUserMessage(params.clientUserMessageId ?? null, parsedInput.content),
		);
		return { turnId: activeTurn.turnId };
	}

	async interruptTurn(params: TurnInterruptParams): Promise<TurnInterruptResponse> {
		const entry = this.getLoadedThreadOrThrow(params.threadId);
		const activeTurn = entry.activeTurn;
		if (!activeTurn) {
			return {};
		}
		if (activeTurn.turnId !== params.turnId) {
			throw invalidRequest(`Turn id mismatch: expected ${params.turnId} but active turn is ${activeTurn.turnId}`);
		}
		const pending = this.pendingByThreadId.get(params.threadId);
		if (pending?.turnId === params.turnId) {
			pending.interrupted = true;
		}
		await entry.session.abort();
		if (entry.activeTurn?.turnId === params.turnId) {
			this.completeTurn(params.threadId, "interrupted");
		}
		return {};
	}

	completeTurn(
		threadId: ThreadId,
		status: Exclude<TurnWireStatus, "inProgress"> = "completed",
		message?: string,
	): void {
		const entry = this.getLoadedThreadOrThrow(threadId);
		const activeTurn = entry.activeTurn;
		const pending = this.pendingByThreadId.get(threadId);
		if (!activeTurn || !pending || pending.completed || pending.turnId !== activeTurn.turnId) {
			return;
		}

		pending.completed = true;
		// Close dangling projected items first so they land on the wire and in the
		// turn log before turn/completed reads the logged items.
		this.finalizeProjection(threadId);
		const completedStatus = pending.interrupted && status === "completed" ? "interrupted" : status;
		const completedAtMs = Date.now();
		this.turnLog.completeTurn(threadId, pending.turnId, completedStatus);
		const turn = buildTurn(
			pending.turnId,
			completedStatus,
			pending.startedAtMs,
			completedAtMs,
			readLoggedItems(this.turnLog, threadId, pending.turnId),
			message,
		);

		entry.activeTurn = null;
		entry.status = "idle";
		entry.updatedAt = new Date(completedAtMs).toISOString();
		this.pendingByThreadId.delete(threadId);
		this.emitToThread(threadId, { method: "turn/completed", params: { threadId, turn } });
		this.broadcast({ method: "thread/status/changed", params: { threadId, status: { type: "idle" } } });
		pending.resolve();
	}

	private emitUserMessage(threadId: ThreadId, turnId: string, startedAtMs: number, userMessage: WireItem): void {
		const wireUserMessage = wireItemToJson(userMessage);
		this.emitToThread(threadId, {
			method: "item/started",
			params: { threadId, turnId, item: wireUserMessage, startedAtMs },
		});
		this.emitToThread(threadId, {
			method: "item/completed",
			params: { threadId, turnId, item: wireUserMessage, completedAtMs: startedAtMs },
		});
		this.turnLog.appendItem(threadId, turnId, userMessage);
	}

	private ensureSessionSubscription(threadId: ThreadId, entry: Entry): void {
		if (this.subscribedThreadIds.has(threadId)) {
			return;
		}
		this.subscribedThreadIds.add(threadId);
		entry.session.subscribe((event) => {
			this.projectSessionEvent(threadId, event);
			if (event.type === "agent_end") {
				this.completeTurn(threadId);
			}
		});
	}

	private projectSessionEvent(threadId: ThreadId, event: TurnEngineSessionEvent): void {
		let entry: Entry;
		try {
			entry = this.getLoadedThreadOrThrow(threadId);
		} catch {
			return;
		}
		const activeTurn = entry.activeTurn;
		if (!activeTurn) {
			return;
		}
		let state = this.projectorByThreadId.get(threadId);
		if (!state || state.turnId !== activeTurn.turnId) {
			state = {
				turnId: activeTurn.turnId,
				projector: new EventProjector({
					threadId,
					turnId: activeTurn.turnId,
					turnLog: this.turnLog,
					cwd: entry.cwd,
				}),
			};
			this.projectorByThreadId.set(threadId, state);
		}
		// The engine only ever sees real AgentSession events at runtime; the
		// narrow TurnEngineSessionEvent supertype exists so unit tests can drive
		// the engine with minimal fakes. Unknown event types project to nothing.
		const result = state.projector.project(event as AgentSessionEvent);
		this.emitProjected(threadId, result.notifications);
		const completion = result.turnCompletion;
		if (completion && completion.status !== "completed" && completion.status !== "running") {
			this.completeTurn(threadId, completion.status, completion.errorMessage);
		}
	}

	private finalizeProjection(threadId: ThreadId): void {
		const state = this.projectorByThreadId.get(threadId);
		if (!state) {
			return;
		}
		this.projectorByThreadId.delete(threadId);
		this.emitProjected(threadId, state.projector.finalize());
	}

	private emitProjected(threadId: ThreadId, notifications: readonly ProjectedNotification[]): void {
		for (const notification of notifications) {
			this.emitToThread(threadId, { method: notification.method, params: notification.params as JsonValue });
		}
	}

	private getLoadedThreadOrThrow(threadId: ThreadId): Entry {
		try {
			return this.store.getLoadedThread(threadId);
		} catch {
			throw invalidRequest(`Thread not found: ${threadId}`);
		}
	}
}
