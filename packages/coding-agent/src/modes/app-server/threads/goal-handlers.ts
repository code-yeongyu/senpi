import { clearGoal, createGoal, readGoal, updateGoal } from "../../../core/extensions/builtin/goal/store.ts";
import { goalStoreRef } from "../../../core/extensions/builtin/goal/store-ref.ts";
import type { GoalStatus, GoalUpdate } from "../../../core/extensions/builtin/goal/types.ts";
import type { ThreadGoalClearResponse, ThreadGoalGetResponse, ThreadGoalSetResponse } from "../protocol/index.ts";
import type { MethodHandler, MethodRegistry, RegistryConnection, RpcRequest } from "../rpc/registry.ts";
import type { NotificationRouter } from "../server/notifications.ts";
import { toThreadGoal } from "./goal-wire.ts";
import { connectionId, objectValue, requiredString } from "./handler-params.ts";
import { type ThreadEntry, ThreadNotFoundError, type ThreadRegistry } from "./registry.ts";
import { invalidParams, invalidRequest } from "./turn-runtime.ts";

export interface ThreadGoalHandlersOptions {
	readonly threads: ThreadRegistry;
	readonly notifications: NotificationRouter;
	readonly deferUntilResponded?: (connectionId: string, action: () => Promise<void> | void) => boolean;
}

type GoalHandlerRegistration = {
	readonly method: string;
	readonly handler: MethodHandler;
};

export function registerThreadGoalHandlers(registry: MethodRegistry, options: ThreadGoalHandlersOptions): void {
	const handlers = new ThreadGoalHandlers(options);
	for (const registration of handlers.registrations()) {
		registry.register(registration.method, {
			handler: registration.handler,
			scope: "thread",
		});
	}
}

class ThreadGoalHandlers {
	private readonly threads: ThreadRegistry;
	private readonly notifications: NotificationRouter;
	private readonly deferUntilResponded:
		| ((connectionId: string, action: () => Promise<void> | void) => boolean)
		| undefined;

	constructor(options: ThreadGoalHandlersOptions) {
		this.threads = options.threads;
		this.notifications = options.notifications;
		this.deferUntilResponded = options.deferUntilResponded;
	}

	registrations(): readonly GoalHandlerRegistration[] {
		return [
			{ method: "thread/goal/set", handler: (context) => this.set(context.connection, context.request) },
			{ method: "thread/goal/get", handler: (context) => this.get(context.request) },
			{ method: "thread/goal/clear", handler: (context) => this.clear(context.connection, context.request) },
		];
	}

	private async set(connection: RegistryConnection, request: RpcRequest): Promise<ThreadGoalSetResponse> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const status = parseStatus(params.status);
		const objective = parseObjective(params.objective);
		const tokenBudget = parseTokenBudget(params);
		const entry = await this.requireThread(threadId);
		const ref = goalStoreRef(entry.session.sessionManager, entry.cwd);
		const goal = await this.threads.runThreadTask(threadId, async () => {
			const current = await readGoal(ref);
			if (current === null) {
				if (objective === undefined) {
					throw invalidRequest(`objective is required for new goal: ${threadId}`);
				}
				const created = await createGoal(
					ref,
					objective,
					tokenBudget.present && tokenBudget.value !== null ? tokenBudget.value : undefined,
				);
				return status === undefined || status === "active" ? created : updateGoal(ref, { status });
			}

			const update: GoalUpdate = {
				...(objective === undefined ? {} : { objective }),
				...(status === undefined ? {} : { status }),
				...(tokenBudget.present ? { tokenBudget: tokenBudget.value } : {}),
			};
			return updateGoal(ref, update);
		});
		const response = { goal: toThreadGoal(goal) } satisfies ThreadGoalSetResponse;
		const notify = (): void => {
			this.notifications.broadcast({
				method: "thread/goal/updated",
				params: { threadId, turnId: null, goal: response.goal },
			});
		};
		this.deferOrRun(connection, notify);
		return response;
	}

	private async get(request: RpcRequest): Promise<ThreadGoalGetResponse> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const entry = await this.requireThread(threadId);
		const ref = goalStoreRef(entry.session.sessionManager, entry.cwd);
		const goal = await this.threads.runThreadTask(threadId, () => readGoal(ref));
		return { goal: goal === null ? null : toThreadGoal(goal) };
	}

	private async clear(connection: RegistryConnection, request: RpcRequest): Promise<ThreadGoalClearResponse> {
		const params = objectValue(request.params);
		const threadId = requiredString(params.threadId, "threadId");
		const entry = await this.requireThread(threadId);
		const ref = goalStoreRef(entry.session.sessionManager, entry.cwd);
		const cleared = await this.threads.runThreadTask(threadId, () => clearGoal(ref));
		if (cleared) {
			const notify = (): void => {
				this.notifications.broadcast({ method: "thread/goal/cleared", params: { threadId } });
			};
			this.deferOrRun(connection, notify);
		}
		return { cleared };
	}

	private async requireThread(threadId: string): Promise<ThreadEntry> {
		let entry: ThreadEntry;
		try {
			entry = await this.threads.resumeThread(threadId);
		} catch (error) {
			if (error instanceof ThreadNotFoundError) {
				throw invalidRequest(`thread not found: ${threadId}`);
			}
			throw error;
		}
		if (entry.session.sessionFile === undefined) {
			throw invalidRequest(`ephemeral thread does not support goals: ${threadId}`);
		}
		return entry;
	}

	private deferOrRun(connection: RegistryConnection, action: () => void): void {
		if (this.deferUntilResponded?.(connectionId(connection), action) !== true) {
			action();
		}
	}
}

function parseStatus(value: unknown): GoalStatus | undefined {
	if (value === undefined || value === null) return undefined;
	switch (value) {
		case "active":
			return "active";
		case "paused":
			return "paused";
		case "complete":
			return "complete";
		case "blocked":
		case "usageLimited":
		case "budgetLimited":
			throw invalidRequest(`unsupported goal status: ${value}`);
		default:
			throw invalidParams("Invalid params: status must be active, paused, or complete");
	}
}

function parseObjective(value: unknown): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw invalidParams("Invalid params: objective must be a string or null");
	}
	return value;
}

type TokenBudgetInput = { readonly present: boolean; readonly value?: number | null };

function parseTokenBudget(params: Readonly<Record<string, unknown>>): TokenBudgetInput {
	if (!Object.hasOwn(params, "tokenBudget")) return { present: false };
	const value = params.tokenBudget;
	if (value === null) return { present: true, value: null };
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw invalidParams("Invalid params: tokenBudget must be a non-negative integer or null");
	}
	return { present: true, value };
}
