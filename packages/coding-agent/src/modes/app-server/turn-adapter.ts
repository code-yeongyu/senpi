import type { AgentSession } from "../../core/agent-session.ts";
import type { TurnInterruptParams, TurnStartParams, TurnSteerParams, UserInput } from "./protocol/index.ts";
import type { ClassifiedIncoming, RpcResponse } from "./rpc/envelope.ts";
import type { MethodRegistry, RpcRequest } from "./rpc/registry.ts";
import type { ApprovalBridge } from "./server/approvals.ts";
import type { Connection, ConnectionId, ConnectionInput, TransportKind } from "./server/connection.ts";
import type { ConnectionTransport, NotificationRouter } from "./server/notifications.ts";
import type { ServerCoreOptions } from "./server/server-core.ts";
import { ServerCore } from "./server/server-core.ts";
import { decodeCursor, encodeCursor, objectValue, optionalNumber, optionalString } from "./threads/handler-params.ts";
import type { ThreadEntry, ThreadRegistry } from "./threads/registry.ts";
import { TurnEngineError } from "./threads/turn-runtime.ts";
import type { TurnEngineSession, TurnEngineStore, TurnEngineThreadEntry } from "./threads/turns.ts";

type ModeTurnEntry = TurnEngineThreadEntry;

export function createModeTurnStore(threads: ThreadRegistry): TurnEngineStore<ModeTurnEntry> {
	return new ModeTurnStore(threads);
}

export function turnStartParams(request: RpcRequest): TurnStartParams {
	const params = objectParams(request);
	return {
		threadId: requiredStringParam(params.threadId, "threadId"),
		clientUserMessageId: optionalNullableStringParam(params.clientUserMessageId, "clientUserMessageId"),
		input: userInputArrayParam(params.input),
	};
}

export function turnSteerParams(request: RpcRequest): TurnSteerParams {
	const params = objectParams(request);
	return {
		threadId: requiredStringParam(params.threadId, "threadId"),
		expectedTurnId: requiredStringParam(params.expectedTurnId, "expectedTurnId"),
		clientUserMessageId: optionalNullableStringParam(params.clientUserMessageId, "clientUserMessageId"),
		input: userInputArrayParam(params.input),
	};
}

export function turnInterruptParams(request: RpcRequest): TurnInterruptParams {
	const params = objectParams(request);
	return {
		threadId: requiredStringParam(params.threadId, "threadId"),
		turnId: requiredStringParam(params.turnId, "turnId"),
	};
}

export function createRoutedServerCore(
	registry: MethodRegistry,
	notifications: NotificationRouter,
	approvals: ApprovalBridge,
	onThreadSubscribersEmpty?: (threadId: string) => void,
	options: Omit<ServerCoreOptions, "registry"> = {},
): ServerCore {
	return new RoutedServerCore(registry, notifications, approvals, onThreadSubscribersEmpty, options);
}

export function registerLoadedThreadObjectListHandler(registry: MethodRegistry, threads: ThreadRegistry): void {
	registry.register("thread/loaded/list", {
		scope: "thread",
		handler: (context) => {
			const params = objectValue(context.request.params);
			const cursor = decodeCursor(optionalString(params.cursor) ?? null);
			const limit = optionalNumber(params.limit) ?? Number.POSITIVE_INFINITY;
			const loaded = threads.listLoaded().map((thread) => thread.id);
			const data = loaded.slice(cursor, cursor + limit);
			const nextOffset = cursor + data.length;
			return {
				data,
				nextCursor: nextOffset < loaded.length ? encodeCursor(nextOffset) : null,
			};
		},
	});
}

class RoutedServerCore extends ServerCore {
	private readonly notifications: NotificationRouter;
	private readonly approvals: ApprovalBridge;
	private readonly onThreadSubscribersEmpty: ((threadId: string) => void) | undefined;

	constructor(
		registry: MethodRegistry,
		notifications: NotificationRouter,
		approvals: ApprovalBridge,
		onThreadSubscribersEmpty?: (threadId: string) => void,
		options: Omit<ServerCoreOptions, "registry"> = {},
	) {
		super({ ...options, registry });
		this.notifications = notifications;
		this.approvals = approvals;
		this.onThreadSubscribersEmpty = onThreadSubscribersEmpty;
	}

	override addConnection(input: ConnectionInput): Connection {
		const connection = super.addConnection(input);
		this.notifications.addConnection({
			id: connection.id,
			get initialized() {
				return connection.initialized;
			},
			get transport() {
				return routerTransport(connection.transportKind);
			},
			get capabilities() {
				return connection.capabilities;
			},
			get optOutNotificationMethods() {
				return [...connection.optOutNotificationMethods];
			},
			send: (message) => connection.send(message),
			close: () => {
				void connection.close("slow-client");
			},
		});
		return connection;
	}

	override removeConnection(id: ConnectionId): void {
		const emptiedThreadIds = this.notifications.removeConnection(id);
		super.removeConnection(id);
		for (const threadId of emptiedThreadIds) {
			this.onThreadSubscribersEmpty?.(threadId);
		}
	}

	override async receive(connectionId: ConnectionId, envelope: ClassifiedIncoming): Promise<void> {
		if (envelope.kind === "response" && this.resolveApproval(envelope.message)) {
			return;
		}
		await super.receive(connectionId, envelope);
	}

	private resolveApproval(response: RpcResponse): boolean {
		const id = response.id;
		if (id === null) {
			return false;
		}
		if ("result" in response) {
			return this.approvals.resolveResponse({ id, result: response.result });
		}
		return this.approvals.resolveResponse({ id, error: response.error });
	}
}

class ModeTurnStore implements TurnEngineStore<ModeTurnEntry> {
	private readonly threads: ThreadRegistry;

	constructor(threads: ThreadRegistry) {
		this.threads = threads;
	}

	getLoadedThread(threadId: string): ModeTurnEntry {
		return new ModeTurnThreadEntry(this.threads.getLoadedThread(threadId));
	}

	runThreadTask<T>(threadId: string, task: () => Promise<T> | T): Promise<T> {
		return this.threads.runThreadTask(threadId, task);
	}
}

class ModeTurnThreadEntry implements TurnEngineThreadEntry {
	private readonly entry: ThreadEntry;
	private readonly sessionAdapter: TurnEngineSession;

	constructor(entry: ThreadEntry) {
		this.entry = entry;
		this.sessionAdapter = new ModeTurnSession(entry.session);
	}

	get id(): string {
		return this.entry.id;
	}

	get cwd(): string {
		return this.entry.cwd;
	}

	get session(): TurnEngineSession {
		return this.sessionAdapter;
	}

	get activeTurn() {
		return this.entry.activeTurn;
	}

	set activeTurn(value) {
		this.entry.activeTurn = value;
	}

	get status() {
		return this.entry.status;
	}

	set status(value) {
		this.entry.status = value;
	}

	get updatedAt(): string {
		return this.entry.updatedAt;
	}

	set updatedAt(value: string) {
		this.entry.updatedAt = value;
	}
}

class ModeTurnSession implements TurnEngineSession {
	private readonly session: AgentSession;

	constructor(session: AgentSession) {
		this.session = session;
	}

	prompt(
		text: string,
		options?: { readonly source?: "rpc"; readonly preflightResult?: (success: boolean) => void },
	): Promise<void> {
		return this.session.prompt(text, options);
	}

	steer(text: string): Promise<void> {
		return this.session.steer(text);
	}

	abort(): Promise<void> {
		return this.session.abort();
	}

	subscribe(listener: (event: { readonly type: string }) => void): () => void {
		// Pass the full AgentSessionEvent through: the turn engine projects these
		// into item/* notifications, so stripping payloads here would silence the
		// entire assistant/tool item stream.
		return this.session.subscribe(listener);
	}
}

function objectParams(request: RpcRequest): Readonly<Record<string, unknown>> {
	if (typeof request.params === "object" && request.params !== null && !Array.isArray(request.params)) {
		return Object.fromEntries(Object.entries(request.params));
	}
	throw new TurnEngineError({ code: -32602, message: "Invalid params" });
}

function requiredStringParam(value: unknown, name: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new TurnEngineError({ code: -32602, message: `Invalid params: ${name} is required` });
	}
	return value;
}

function optionalNullableStringParam(value: unknown, name: string): string | null | undefined {
	if (value === undefined || value === null) return value;
	if (typeof value !== "string") {
		throw new TurnEngineError({ code: -32602, message: `Invalid params: ${name} must be a string` });
	}
	return value;
}

function userInputArrayParam(value: unknown): readonly UserInput[] {
	if (!Array.isArray(value)) {
		throw new TurnEngineError({ code: -32602, message: "Invalid params: input must be an array" });
	}
	return value.map(userInputParam);
}

function userInputParam(value: unknown): UserInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TurnEngineError({ code: -32602, message: "Invalid params: input item must be an object" });
	}
	const item = Object.fromEntries(Object.entries(value));
	const type = item.type;
	switch (type) {
		case "text":
			return {
				type,
				text: requiredStringParam(item.text, "input.text"),
				text_elements: Array.isArray(item.text_elements) ? item.text_elements : [],
			};
		case "image":
			return { type, url: requiredStringParam(item.url, "input.url") };
		case "localImage":
			return { type, path: requiredStringParam(item.path, "input.path") };
		case "skill":
		case "mention":
			return {
				type,
				name: requiredStringParam(item.name, "input.name"),
				path: requiredStringParam(item.path, "input.path"),
			};
		default:
			throw new TurnEngineError({ code: -32602, message: "Invalid params: unsupported input item type" });
	}
}

function routerTransport(transport: TransportKind): ConnectionTransport {
	switch (transport) {
		case "stdio":
			return "stdio";
		case "websocket":
			return "ws";
		case "unix":
			return "unix";
	}
}
