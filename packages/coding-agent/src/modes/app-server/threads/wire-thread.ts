import { VERSION } from "../../../config.ts";
import type { SessionEntry } from "../../../core/session-manager.ts";
import type { Thread, ThreadItem, ThreadStatus, Turn, TurnItemsView } from "../protocol/index.ts";
import { ThreadMetadataState } from "./metadata-state.ts";
import type { ThreadEntry, WireThread } from "./registry.ts";
import type { LoggedTurn, TurnLog, WireItem } from "./turn-log.ts";
import { wireItemToJson } from "./turn-runtime.ts";

const ACTIVE_STATUS: ThreadStatus = { type: "active", activeFlags: [] };
const IDLE_STATUS: ThreadStatus = { type: "idle" };
export const NOT_LOADED_STATUS: ThreadStatus = { type: "notLoaded" };
const metadataState = new ThreadMetadataState();

export interface BuildWireThreadOptions {
	readonly forkedFromId?: string | null;
	readonly recencyAt?: string | null;
}

export type ThreadHistorySource = {
	readonly id: string;
	readonly createdAt: string;
	readonly entries: readonly SessionEntry[];
};

export async function buildWireThread(
	entry: ThreadEntry | WireThread,
	turnLog: TurnLog,
	includeTurns: boolean,
	options: BuildWireThreadOptions = {},
): Promise<Thread> {
	const model = "session" in entry ? entry.session.model : undefined;
	const wire = "session" in entry ? entryToWire(entry) : entry;
	const createdAt = isoSeconds(wire.createdAt);
	const updatedAt = isoSeconds(wire.updatedAt);
	return {
		id: wire.id,
		sessionId: wire.sessionId,
		forkedFromId: options.forkedFromId ?? null,
		parentThreadId: null,
		preview: wire.preview ?? "",
		ephemeral: false,
		modelProvider: model?.provider ?? "unknown",
		createdAt,
		updatedAt,
		recencyAt: options.recencyAt === null ? null : isoSeconds(options.recencyAt ?? wire.updatedAt),
		status: toGeneratedStatus(wire.status.type),
		path: "session" in entry ? (entry.session.sessionFile ?? null) : wire.sessionPath,
		cwd: wire.cwd,
		cliVersion: VERSION,
		source: "appServer",
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: await metadataState.readGitInfo(wire),
		name: wire.name,
		turns: includeTurns ? threadTurns(entry, turnLog) : [],
	};
}

function entryToWire(entry: ThreadEntry): WireThread {
	return {
		id: entry.id,
		sessionId: entry.session.sessionId,
		sessionPath: entry.session.sessionFile ?? null,
		cwd: entry.cwd,
		createdAt: entry.createdAt,
		updatedAt: entry.updatedAt,
		status: { type: entry.status },
		preview: entry.session.getUserMessagesForForking()[0]?.text ?? null,
		name: entry.session.sessionName ?? null,
	};
}

export function loggedTurnToWireTurn(turn: LoggedTurn, itemsView: TurnItemsView = "full"): Turn {
	const items = turn.items.map(wireItemToThreadItem);
	return {
		id: turn.turnId,
		items: itemsForView(items, itemsView),
		itemsView,
		status: turn.status === "running" ? "inProgress" : turn.status,
		error: turn.error === null ? null : { message: turn.error, codexErrorInfo: "other", additionalDetails: null },
		startedAt: isoSeconds(turn.startedAt),
		completedAt: turn.completedAt === null ? null : isoSeconds(turn.completedAt),
		durationMs: turn.durationMs,
	};
}

export function turnsForEntry(entry: ThreadEntry | WireThread | ThreadHistorySource, turnLog: TurnLog): LoggedTurn[] {
	const loggedTurns = turnLog.readTurns(entry.id);
	if (loggedTurns.length > 0) {
		return loggedTurns;
	}
	const entries =
		"session" in entry ? entry.session.sessionManager.getEntries() : "entries" in entry ? entry.entries : [];
	return turnsFromSessionEntries(entries, entry.createdAt);
}

function turnsFromSessionEntries(entries: readonly SessionEntry[], fallbackStartedAt: string): LoggedTurn[] {
	const turns: LoggedTurn[] = [];
	let current: LoggedTurn | undefined;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		if (entry.message.role === "user") {
			current = {
				turnId: `turn-${turns.length + 1}`,
				startedAt: entry.timestamp || fallbackStartedAt,
				completedAt: null,
				durationMs: null,
				error: null,
				status: "completed",
				items: [{ id: entry.id, type: "userMessage", content: userInputContent(entry.message.content) }],
			};
			turns.push(current);
			continue;
		}
		if (entry.message.role !== "assistant" || !current) continue;
		const text = assistantText(entry.message.content);
		if (text.length === 0) continue;
		current.items.push({
			id: entry.id,
			type: "agentMessage",
			text,
			phase: null,
			memoryCitation: null,
		});
	}
	return turns;
}

function userInputContent(content: unknown): WireItem[] {
	if (typeof content === "string") return [{ type: "text", text: content, text_elements: [] }];
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") return [];
		return [{ type: "text", text: item.text, text_elements: [] }];
	});
}

function assistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []))
		.join("");
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function threadTurns(entry: ThreadEntry | WireThread, turnLog: TurnLog): Turn[] {
	return turnsForEntry(entry, turnLog).map((turn) => loggedTurnToWireTurn(turn));
}

export function wireItemToThreadItem(item: WireItem): ThreadItem {
	const type = item.type;
	const id = typeof item.id === "string" && item.id.length > 0 ? item.id : "item";
	const jsonItem = wireItemToJson(item);
	if (type === "userMessage") {
		return {
			...jsonItem,
			type: "userMessage",
			id,
			clientId: typeof item.clientId === "string" ? item.clientId : null,
			content: Array.isArray(jsonItem.content) ? jsonItem.content : [],
		};
	}
	if (type === "reasoning") {
		return {
			...jsonItem,
			type: "reasoning",
			id,
			summary: Array.isArray(jsonItem.summary) ? jsonItem.summary : [],
			content: Array.isArray(jsonItem.content) ? jsonItem.content : [stringField(item, "text")],
		};
	}
	if (type === "plan") {
		return { ...jsonItem, type: "plan", id, text: stringField(item, "text") };
	}
	if (type === "agentMessage") {
		return {
			...jsonItem,
			type: "agentMessage",
			id,
			text: stringField(item, "text"),
			phase: jsonItem.phase ?? null,
			memoryCitation: jsonItem.memoryCitation ?? null,
		};
	}
	return { ...jsonItem, type: typeof type === "string" ? type : "agentMessage", id };
}

function itemsForView(items: ThreadItem[], itemsView: TurnItemsView): ThreadItem[] {
	if (itemsView === "notLoaded") return [];
	if (itemsView === "full") return items;
	const firstUserMessage = items.find((item) => item.type === "userMessage");
	const finalAgentMessage = [...items].reverse().find((item) => item.type === "agentMessage");
	if (firstUserMessage && finalAgentMessage && firstUserMessage.id !== finalAgentMessage.id) {
		return [firstUserMessage, finalAgentMessage];
	}
	return firstUserMessage ? [firstUserMessage] : finalAgentMessage ? [finalAgentMessage] : [];
}

function stringField(item: WireItem, key: string): string {
	const value = item[key];
	return typeof value === "string" ? value : "";
}

function toGeneratedStatus(status: WireThread["status"]["type"]): ThreadStatus {
	switch (status) {
		case "active":
			return ACTIVE_STATUS;
		case "idle":
			return IDLE_STATUS;
		case "notLoaded":
			return NOT_LOADED_STATUS;
	}
}

function isoSeconds(value: string): number {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed / 1000 : 0;
}
