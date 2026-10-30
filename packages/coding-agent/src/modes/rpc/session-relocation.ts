/**
 * `session_relocation` (docs/rpc.md "Continuing a session on another computer"): the session asks the connection that
 * offers relocation with `host_request`, only that connection's `host_response` counts, and an accepted move is
 * announced to it with `relocation_due` once the run that asked for it settles. The engine never interrupts that run and
 * never moves anything itself: the host runs the existing `release_session` reason `move` and `move_session` steps.
 */
import type { AgentSession } from "../../core/agent-session.ts";
import { isPlainId } from "../../core/session-move/bundle.ts";
import {
	RELOCATION_NOT_OFFERED,
	type RelocationRefused,
	type RelocationRequest,
	type RelocationRequestResult,
	type RelocationTarget,
	type RelocationTargetsResult,
	type SessionRelocationHost,
} from "../../core/session-relocation.ts";
import type { RpcHostRequest, RpcHostResponse, RpcRelocationDueEvent } from "./rpc-types.ts";
import type { HostResponseOutcome, RelocationChannel } from "./session-relocation-channel.ts";

/** Longest the session waits for the host's answer before refusing the request itself. */
export const HOST_ANSWER_TIMEOUT_MS = 60_000;

type Answer = { readonly data: unknown } | RelocationRefused;
type Pending = { readonly connection: string; readonly finish: (answer: Answer) => void };
type Scheduled = {
	readonly moveId: string;
	readonly target: string;
	readonly reason: string;
	readonly connection: string;
	readonly dropReason?: "aborted";
};
type HostAsk = { method: "list_relocation_targets" } | { method: "relocate_session"; target: string; reason: string };

export interface RpcSessionRelocationDeps {
	readonly session: Pick<
		AgentSession,
		"sessionFile" | "subscribe" | "isStreaming" | "currentAbortSource" | "sendCustomMessage"
	>;
	/** `prompt` calls not yet returned; `release_session` counts them as a running turn (`busy: ["prompt"]`). */
	readonly pendingPrompts: () => readonly Promise<unknown>[];
	readonly channel: RelocationChannel;
}

const refused = (reason: string, detail: string): RelocationRefused => ({ status: "refused", reason, detail });
const record = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? { ...value } : undefined;

function parseTarget(value: unknown): RelocationTarget | undefined {
	const fields = record(value);
	if (typeof fields?.name !== "string" || fields.name === "" || typeof fields.online !== "boolean") return undefined;
	return {
		name: fields.name,
		online: fields.online,
		...(typeof fields.capacity === "string" ? { capacity: fields.capacity } : {}),
		...(typeof fields.aboutToSleep === "boolean" ? { aboutToSleep: fields.aboutToSleep } : {}),
	};
}

export class RpcSessionRelocation implements SessionRelocationHost {
	private readonly deps: RpcSessionRelocationDeps;
	private readonly pending = new Map<string, Pending>();
	private readonly unsubscribe: () => void;
	private scheduled: Scheduled | undefined;
	private requesting = false;

	constructor(deps: RpcSessionRelocationDeps) {
		this.deps = deps;
		this.unsubscribe = deps.session.subscribe((event) => {
			// A run the user stopped takes its scheduled move with it: the user chose to stay here.
			if (event.type === "agent_end" && deps.session.currentAbortSource === "user" && this.scheduled !== undefined)
				this.scheduled = { ...this.scheduled, dropReason: "aborted" };
			if (event.type === "agent_settled" && this.scheduled !== undefined) {
				// agent_end still streams: wait until settlement so the correction is appended, not parked.
				if (this.scheduled.dropReason !== undefined) this.dropScheduled(this.scheduled.dropReason);
				else void this.announceWhenReleasable();
			}
		});
	}

	offered(): boolean {
		return this.deps.channel.offerer() !== undefined;
	}

	async targets(signal?: AbortSignal): Promise<RelocationTargetsResult> {
		const connection = this.deps.channel.offerer();
		if (connection === undefined) return RELOCATION_NOT_OFFERED;
		const answer = await this.ask({ method: "list_relocation_targets" }, connection, signal);
		if ("status" in answer) return answer;
		const raw = record(answer.data)?.targets;
		const targets = Array.isArray(raw) ? raw.map(parseTarget) : undefined;
		if (targets === undefined || targets.some((target) => target === undefined))
			return refused("invalid_host_answer", "the app sent a list of computers this session cannot read");
		return { status: "listed", targets: targets.filter((target) => target !== undefined) };
	}

	async request(request: RelocationRequest, signal?: AbortSignal): Promise<RelocationRequestResult> {
		const connection = this.deps.channel.offerer();
		if (connection === undefined) return RELOCATION_NOT_OFFERED;
		if (this.deps.session.sessionFile === undefined)
			return { status: "unavailable", reason: "not_releasable", detail: "this session is not saved to a file" };
		if (this.scheduled !== undefined || this.requesting)
			return refused(
				"already_scheduled",
				`a move to ${this.scheduled?.target ?? "another computer"} is already set for the end of this turn`,
			);
		this.requesting = true;
		try {
			const ask: HostAsk = { method: "relocate_session", target: request.target, reason: request.reason };
			const answer = await this.ask(ask, connection, signal);
			if ("status" in answer) return answer;
			return this.settleRequest(request, record(answer.data), connection);
		} finally {
			this.requesting = false;
		}
	}

	/** Settles one `host_response`; only the connection the request went to may answer it. */
	respond(frame: RpcHostResponse): HostResponseOutcome {
		const pending = this.pending.get(frame.id);
		if (pending === undefined) return "unknown";
		if (this.deps.channel.current() !== pending.connection) return "not_offering_connection";
		pending.finish(typeof frame.error === "string" ? refused("host_error", frame.error) : { data: frame.data });
		return "answered";
	}

	/** The connection `connectionId` left the session: what it accepted or was asked ends here, never later. */
	connectionDetached(connectionId: string): void {
		if (this.scheduled?.connection === connectionId && this.scheduled.dropReason === undefined)
			this.dropScheduled("disconnected");
		for (const pending of [...this.pending.values()])
			if (pending.connection === connectionId)
				pending.finish(refused("app_disconnected", "the app that was asked left this session"));
	}

	dispose(): void {
		this.unsubscribe();
		this.scheduled = undefined;
		for (const { finish } of [...this.pending.values()]) finish(refused("session_closed", "this session was closed"));
	}

	private dropScheduled(reason: "disconnected" | "aborted" | "withdrawn"): void {
		const scheduled = this.scheduled;
		if (scheduled === undefined) return;
		this.scheduled = undefined;
		const { moveId, target } = scheduled;
		void this.deps.session.sendCustomMessage(
			{
				customType: "session_relocation",
				content: `The session will not continue on ${target} (${reason}). The session stays on this computer; keep working here.`,
				display: false,
				details: { status: "dropped", reason, moveId, target },
			},
			{ triggerTurn: false },
		);
	}

	private settleRequest(
		request: RelocationRequest,
		data: Record<string, unknown> | undefined,
		connection: string,
	): RelocationRequestResult {
		if (data?.accepted === false)
			return refused(
				typeof data.reason === "string" && data.reason !== "" ? data.reason : "declined",
				typeof data.detail === "string" && data.detail !== "" ? data.detail : "the app declined the move",
			);
		if (data?.accepted !== true || !isPlainId(data.moveId))
			return refused("invalid_host_answer", "the app accepted the move without a usable move id");
		const target = typeof data.target === "string" && data.target !== "" ? data.target : request.target;
		this.scheduled = { moveId: data.moveId, target, reason: request.reason, connection };
		return { status: "scheduled", target, moveId: data.moveId };
	}

	/** After the run settled, waits out the prompt calls behind it, so a `release_session` answering the notice finds the session quiet. */
	private async announceWhenReleasable(): Promise<void> {
		for (let calls = this.deps.pendingPrompts(); calls.length > 0; calls = this.deps.pendingPrompts())
			await Promise.allSettled(calls);
		const due = this.scheduled;
		// A new run took over meanwhile: its own settle announces the move.
		if (due === undefined || this.deps.session.isStreaming) return;
		// Only the connection that accepted, while it still offers relocation here, is told to move the session.
		if (this.deps.channel.offerer() !== due.connection) {
			this.dropScheduled("withdrawn");
			return;
		}
		this.scheduled = undefined;
		const { connection, moveId, target, reason } = due;
		this.deps.channel.send(
			connection,
			{ type: "relocation_due", moveId, target, reason } satisfies RpcRelocationDueEvent,
			"event",
		);
	}

	private ask(fields: HostAsk, connection: string, signal?: AbortSignal): Promise<Answer> {
		if (signal?.aborted) return Promise.resolve(refused("cancelled", "the request was cancelled"));
		const id = `hr_${crypto.randomUUID()}`;
		return new Promise<Answer>((resolve) => {
			const finish = (answer: Answer): void => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(id);
				resolve(answer);
			};
			const onAbort = (): void => finish(refused("cancelled", "the request was cancelled"));
			const timer = setTimeout(
				() => finish(refused("no_answer", "the app did not answer in time")),
				HOST_ANSWER_TIMEOUT_MS,
			);
			this.pending.set(id, { connection, finish });
			signal?.addEventListener("abort", onAbort, { once: true });
			this.deps.channel.send(
				connection,
				{ type: "host_request", id, ...fields } satisfies RpcHostRequest,
				"request",
			);
		});
	}
}
