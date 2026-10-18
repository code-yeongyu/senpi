/**
 * How an RPC record reads as one monitor line. A session is named by its label - the task id it was
 * opened for, else its name, else the first 8 characters of its durable id - with its routing id in
 * parentheses the first time it appears in a batch. Status lines carry the transition (the renderer
 * remembers each session's last status, seeded from the subscription snapshot); unknown kinds render as
 * truncated JSON, because the monitor keeps no allowlist of record kinds.
 */
import type { RpcRecord } from "./rpc-monitor-observer.ts";

const UNKNOWN_JSON_LIMIT = 160;

interface SessionView {
	label: string;
	status: string;
}

export class RpcMonitorRenderer {
	readonly #sessions = new Map<string, SessionView>();
	readonly #namedThisBatch = new Set<string>();

	/** Remembers the sessions a subscription answer listed; returns the arm-time RESULT rows. */
	seed(socket: string, snapshot: readonly RpcRecord[]): string[] {
		return snapshot.map((row) => {
			const view = this.#view(socket, row);
			view.status = String(row.status);
			const model = modelId(row.model);
			const attachments = typeof row.attachments === "number" ? row.attachments : 0;
			return `${view.label} ${view.status} (${attachments} attached${model === undefined ? "" : `, model ${model}`})`;
		});
	}

	/** Drops every session an endpoint reported; returns how many. */
	forgetSocket(socket: string): number {
		let count = 0;
		for (const key of [...this.#sessions.keys()])
			if (key.startsWith(`${socket}#`)) {
				this.#sessions.delete(key);
				count++;
			}
		return count;
	}

	/** Every session this renderer knows, with its last status: what a checkpoint records. */
	statuses(): ReadonlyMap<string, string> {
		return new Map([...this.#sessions].map(([key, view]) => [key, view.status]));
	}

	label(socket: string, record: RpcRecord): string {
		const view = this.#view(socket, record);
		const key = sessionKey(socket, record);
		if (this.#namedThisBatch.has(key)) return view.label;
		if (this.#namedThisBatch.size === 0) queueMicrotask(() => this.#namedThisBatch.clear());
		this.#namedThisBatch.add(key);
		return `${view.label} (${String(record.sessionId)})`;
	}

	/** One line for a non-coalesced record, or undefined when it changes nothing worth a line. */
	render(socket: string, record: RpcRecord): string | undefined {
		switch (record.type) {
			case "session_status":
				return this.#status(socket, record);
			case "effect_status": {
				const detail = record.disposition ?? reasonOf(record.outcome);
				return `rpc ${this.label(socket, record)} effect ${String(record.kind)} ${tail(String(record.effectId))} ${String(record.state)}${detail === undefined ? "" : ` (${String(detail)})`}`;
			}
			case "agent_end":
				return `rpc ${this.label(socket, record)} agent_end${record.aborted === true ? ` aborted(${String(record.abortSource ?? "user")})` : ""}`;
			case "model_changed":
				return `rpc ${this.label(socket, record)} model_changed -> ${modelId(record.model) ?? "?"}${record.source === undefined ? "" : ` (${String(record.source)})`}`;
			case "queue_update":
				return `rpc ${this.label(socket, record)} queue_update steering=${count(record.steering)} followUp=${count(record.followUp)}`;
			case "session_replaced":
				return `rpc ${this.label(socket, record)} session_replaced -> ${String(record.durableSessionId ?? record.newSessionId ?? "?")}`;
			case "session_closed":
				return `rpc ${this.label(socket, record)} session_closed ${String(record.reason ?? "")}`.trimEnd();
			case "extension_event":
				return `rpc ${this.label(socket, record)} extension_event ${String(record.name ?? record.event ?? "")}`.trimEnd();
			case "entry_appended":
				return `rpc ${this.label(socket, record)} entry_appended ${entryType(record)}`;
			case "tool_execution_start":
			case "tool_execution_end":
				return `rpc ${this.label(socket, record)} tool ${String(record.toolName ?? "?")} ${record.type === "tool_execution_start" ? "started" : "ended"}`;
			case "turn_end":
			case "turn_start":
			case "agent_start":
			case "agent_idle":
			case "agent_settled":
				return `rpc ${this.label(socket, record)} ${record.type}`;
			default: {
				const { type: _type, sessionId: _sessionId, ...rest } = record;
				const json = JSON.stringify(rest);
				const body = json.length > UNKNOWN_JSON_LIMIT ? `${json.slice(0, UNKNOWN_JSON_LIMIT)}...` : json;
				return `rpc ${this.label(socket, record)} ${String(record.type)} ${body}`;
			}
		}
	}

	#status(socket: string, record: RpcRecord): string | undefined {
		const view = this.#view(socket, record);
		const to = String(record.status);
		const from = view.status;
		view.status = to;
		if (from === to) return undefined;
		const change = record.lastChange as { cause?: unknown; by?: unknown } | undefined;
		const why = change === undefined ? "" : ` (${String(change.cause)}, by ${String(change.by)})`;
		return `rpc ${this.label(socket, record)} status ${from} -> ${to}${why} seq=${String(record.seq)}`;
	}

	#view(socket: string, record: RpcRecord): SessionView {
		const key = sessionKey(socket, record);
		let view = this.#sessions.get(key);
		if (view === undefined) {
			view = { label: labelOf(record), status: "unknown" };
			this.#sessions.set(key, view);
		} else if (typeof record.name === "string" || contextTask(record) !== undefined) view.label = labelOf(record);
		return view;
	}
}

export function sessionKey(socket: string, record: RpcRecord): string {
	return `${socket}#${String(record.sessionId)}`;
}

function labelOf(record: RpcRecord): string {
	const task = contextTask(record);
	if (task !== undefined) return task;
	if (typeof record.name === "string" && record.name !== "") return record.name;
	const durable = typeof record.durableSessionId === "string" ? record.durableSessionId : String(record.sessionId);
	return durable.slice(0, 8);
}

function contextTask(record: RpcRecord): string | undefined {
	const context = record.context as Record<string, unknown> | undefined;
	return typeof context?.task_id === "string" ? context.task_id : undefined;
}

function modelId(model: unknown): string | undefined {
	return typeof model === "object" && model !== null && "id" in model ? String(model.id) : undefined;
}

function reasonOf(outcome: unknown): string | undefined {
	return typeof outcome === "object" && outcome !== null && "reason" in outcome ? String(outcome.reason) : undefined;
}

function count(value: unknown): number {
	return Array.isArray(value) ? value.length : typeof value === "number" ? value : 0;
}

function tail(id: string): string {
	return id.length > 8 ? id.slice(-8) : id;
}

function entryType(record: RpcRecord): string {
	const entry = record.entry as Record<string, unknown> | undefined;
	return String(entry?.type ?? record.entryType ?? "?");
}
