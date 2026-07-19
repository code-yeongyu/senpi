import { VERSION } from "../../../config.ts";
import type { Thread, ThreadItem, ThreadStatus, Turn } from "../protocol/generated/v2/index.ts";
import { ThreadMetadataState } from "./metadata-state.ts";
import type { ThreadEntry, WireThread } from "./registry.ts";
import type { LoggedTurn, TurnLog, WireItem } from "./turn-log.ts";

const ACTIVE_STATUS: ThreadStatus = { type: "active", activeFlags: [] };
const IDLE_STATUS: ThreadStatus = { type: "idle" };
export const NOT_LOADED_STATUS: ThreadStatus = { type: "notLoaded" };
const metadataState = new ThreadMetadataState();

export interface BuildWireThreadOptions {
	readonly forkedFromId?: string | null;
}

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
		recencyAt: updatedAt,
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

function loggedTurnToWireTurn(turn: LoggedTurn): Turn {
	return {
		id: turn.turnId,
		items: turn.items.map(wireItemToThreadItem),
		itemsView: "full",
		status: turn.status === "running" ? "inProgress" : turn.status,
		error: null,
		startedAt: isoSeconds(turn.startedAt),
		completedAt: null,
		durationMs: null,
	};
}

function threadTurns(entry: ThreadEntry | WireThread, turnLog: TurnLog): Turn[] {
	const loggedTurns = turnLog.readTurns(entry.id);
	if (loggedTurns.length > 0 || !("session" in entry)) {
		return loggedTurns.map(loggedTurnToWireTurn);
	}
	return entry.session.getUserMessagesForForking().map((message, index) =>
		loggedTurnToWireTurn({
			turnId: `turn-${index + 1}`,
			startedAt: entry.createdAt,
			status: "completed",
			items: [{ id: message.entryId, type: "userMessage", content: [] }],
		}),
	);
}

function wireItemToThreadItem(item: WireItem): ThreadItem {
	const type = item.type;
	const id = typeof item.id === "string" && item.id.length > 0 ? item.id : "item";
	if (type === "userMessage") {
		return {
			type: "userMessage",
			id,
			clientId: typeof item.clientId === "string" ? item.clientId : null,
			content: [],
		};
	}
	if (type === "reasoning") {
		return { type: "reasoning", id, summary: [], content: [stringField(item, "text")] };
	}
	if (type === "plan") {
		return { type: "plan", id, text: stringField(item, "text") };
	}
	return { type: "agentMessage", id, text: stringField(item, "text"), phase: null, memoryCitation: null };
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
