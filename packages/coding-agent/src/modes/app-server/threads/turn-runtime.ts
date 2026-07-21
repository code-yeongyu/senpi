import * as crypto from "node:crypto";
import type {
	JsonValue,
	ThreadId,
	Turn,
	TurnInterruptParams,
	TurnInterruptResponse,
	TurnStartParams,
	TurnStartResponse,
	TurnSteerParams,
	TurnSteerResponse,
	UserInput,
} from "../protocol/index.ts";
import { type JsonRpcError, RpcHandlerError } from "../rpc/errors.ts";
import type { ActiveTurn } from "./registry.ts";
import type { TurnLog, WireItem } from "./turn-log.ts";

export type TurnWireStatus = "inProgress" | "completed" | "failed" | "interrupted";
export type LoggedStartStatus = "running";
export type TurnEngineSessionEvent = { readonly type: string };

export interface TurnEngineSession {
	prompt(
		text: string,
		options?: { readonly source?: "rpc"; readonly preflightResult?: (success: boolean) => void },
	): Promise<void>;
	steer(text: string): Promise<void>;
	abort(): Promise<void>;
	subscribe(listener: (event: TurnEngineSessionEvent) => void): () => void;
}

export type TurnEngineThreadStatus = "idle" | "active";

export interface TurnEngineThreadEntry {
	readonly id: string;
	readonly session: TurnEngineSession;
	readonly cwd?: string;
	activeTurn: ActiveTurn | null;
	status: TurnEngineThreadStatus;
	updatedAt: string;
}

export interface TurnEngineStore<Entry extends TurnEngineThreadEntry = TurnEngineThreadEntry> {
	getLoadedThread(threadId: string): Entry;
	runThreadTask<T>(threadId: string, task: () => Promise<T> | T): Promise<T>;
}

export interface TurnEngineNotification {
	readonly method: string;
	readonly params?: JsonValue;
}

export interface TurnEngineOptions<Entry extends TurnEngineThreadEntry = TurnEngineThreadEntry> {
	readonly store: TurnEngineStore<Entry>;
	readonly turnLog: TurnLog;
	readonly emitToThread: (threadId: string, notification: TurnEngineNotification) => void;
	readonly broadcast: (notification: TurnEngineNotification) => void;
}

export type TurnEngineApi = {
	readonly startTurn: (
		params: TurnStartParams,
		deferNotifications?: TurnNotificationDeferral,
	) => Promise<TurnStartResponse>;
	readonly steerTurn: (params: TurnSteerParams) => Promise<TurnSteerResponse>;
	readonly interruptTurn: (
		params: TurnInterruptParams,
		deferNotifications?: TurnNotificationDeferral,
	) => Promise<TurnInterruptResponse>;
	readonly completeTurn: (
		threadId: ThreadId,
		status?: Exclude<TurnWireStatus, "inProgress">,
		message?: string,
	) => void;
};

export type ParsedInput = {
	readonly text: string;
	readonly content: readonly UserInput[];
};

export type TurnNotificationDeferral = (action: () => void) => boolean;

export type PendingTurn = {
	readonly turnId: string;
	readonly startedAt: string;
	readonly startedAtMs: number;
	readonly resolve: () => void;
	interrupted: boolean;
	completed: boolean;
	deferTerminalNotifications: TurnNotificationDeferral | undefined;
};

export function createTurnId(): string {
	return crypto.randomUUID();
}

export class TurnEngineError extends RpcHandlerError {
	readonly error: JsonRpcError;

	constructor(error: JsonRpcError) {
		super(error);
		this.name = "TurnEngineError";
		this.error = error;
	}
}

export function parseInput(input: readonly UserInput[]): ParsedInput {
	if (input.length === 0) {
		throw invalidParams("Invalid params: input must include at least one text item");
	}

	const content: UserInput[] = [];
	const textParts: string[] = [];
	for (const item of input) {
		switch (item.type) {
			case "text": {
				if (item.text.trim().length === 0) {
					throw invalidParams("Invalid params: text input must not be empty");
				}
				const textItem = {
					type: "text",
					text: item.text,
					text_elements: item.text_elements ?? [],
				} satisfies UserInput;
				content.push(textItem);
				textParts.push(item.text);
				break;
			}
			case "image":
			case "localImage":
			case "skill":
			case "mention":
				throw invalidParams(`Invalid params: unsupported input item type ${item.type}`);
			default:
				throw invalidParams("Invalid params: unknown input item type");
		}
	}

	if (textParts.length === 0) {
		throw invalidParams("Invalid params: text input is required");
	}
	return { text: textParts.join("\n"), content };
}

export function buildTurn(
	turnId: string,
	status: TurnWireStatus,
	startedAtMs: number,
	completedAtMs: number | null,
	items: readonly JsonValue[],
	message?: string,
): Turn {
	return {
		id: turnId,
		items,
		itemsView: "full",
		status,
		error:
			status === "failed"
				? {
						message: message ?? "Turn failed",
						codexErrorInfo: "other",
						additionalDetails: null,
					}
				: null,
		startedAt: startedAtMs / 1000,
		completedAt: completedAtMs === null ? null : completedAtMs / 1000,
		durationMs: completedAtMs === null ? null : completedAtMs - startedAtMs,
	};
}

export function buildUserMessage(clientUserMessageId: string | null, content: readonly UserInput[]): WireItem {
	return {
		type: "userMessage",
		id: clientUserMessageId ?? crypto.randomUUID(),
		clientId: clientUserMessageId,
		content: [...content],
	};
}

export type WireJsonObject = { readonly [key: string]: JsonValue | undefined };

export function wireItemToJson(item: WireItem): WireJsonObject {
	const jsonItem: { [key: string]: JsonValue | undefined } = {};
	for (const [key, value] of Object.entries(item)) {
		jsonItem[key] = unknownToJsonValue(value);
	}
	return jsonItem;
}

export function readLoggedItems(turnLog: TurnLog, threadId: ThreadId, turnId: string): readonly JsonValue[] {
	return (
		turnLog
			.readTurns(threadId)
			.find((turn) => turn.turnId === turnId)
			?.items.map((item) => wireItemToJson(item)) ?? []
	);
}

export function invalidRequest(message: string): TurnEngineError {
	return new TurnEngineError({ code: -32600, message });
}

export function invalidParams(message: string): TurnEngineError {
	return new TurnEngineError({ code: -32602, message });
}

export function toTurnEngineError(error: unknown): TurnEngineError {
	if (error instanceof TurnEngineError) {
		return error;
	}
	return new TurnEngineError({ code: -32603, message: error instanceof Error ? error.message : String(error) });
}

function unknownToJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(unknownToJsonValue);
	}
	if (typeof value === "object") {
		const objectValue: { [key: string]: JsonValue | undefined } = {};
		for (const [key, child] of Object.entries(value)) {
			objectValue[key] = unknownToJsonValue(child);
		}
		return objectValue;
	}
	return null;
}
