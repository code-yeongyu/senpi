import {
	type HostToSessionWorker,
	SESSION_WORKER_LIMITS,
	type SessionWorkerToHost,
} from "./session-worker-protocol.ts";

type Request = Extract<HostToSessionWorker, { request: number }>;
type Reply = Extract<SessionWorkerToHost, { request: number }>;
export type WorkerRequestInput = Request extends infer T ? (T extends Request ? Omit<T, "request"> : never) : never;

/** Bounded request debt, with separate admission for interrupt and extension-UI responses. */
export class SessionWorkerRequests {
	private readonly pending = new Map<
		number,
		{
			resolve: (reply: Reply) => void;
			reject: (error: Error) => void;
			bytes: number;
			control: boolean;
			timer?: ReturnType<typeof setTimeout>;
		}
	>();
	private serial = 0;
	private closed = false;
	/**
	 * When the worker's owed, timed answers run out of no-progress budget. Re-armed whenever the worker
	 * starts owing one after owing none, and on every message from it: idle time, when the worker owes
	 * nothing, is never charged (senpi#1719 for the first open, senpi#6452 for a request after a quiet
	 * spell), while a request sent behind another still owed shares that answer's deadline.
	 */
	private progressDeadline = 0;
	private readonly send: (message: Request) => void;
	private readonly timeout: () => void;

	constructor(send: (message: Request) => void, timeout: () => void) {
		this.send = send;
		this.timeout = timeout;
	}

	/**
	 * Any inbound worker message shows the request pipeline is alive: a request that merely runs long
	 * under load is not a dead worker, so the no-progress deadline restarts instead of quarantining the
	 * session (senpi#6452). The timeout VALUE is unchanged; only a worker that stops answering at all
	 * reaches it. Interrupt and extension-UI timers keep their own `controlMs` bound from send: an abort
	 * the worker never answers is cut even while the worker streams other messages.
	 */
	noteProgress(): void {
		if (this.closed) return;
		this.progressDeadline = Date.now() + SESSION_WORKER_LIMITS.openMs;
		for (const pending of this.pending.values()) {
			if (pending.timer === undefined || pending.control) continue;
			clearTimeout(pending.timer);
			pending.timer = setTimeout(this.timeout, SESSION_WORKER_LIMITS.openMs);
		}
	}

	/** What is left of the no-progress budget for a new timed request; a worker that owed nothing starts afresh. */
	private progressBudgetMs(): number {
		const now = Date.now();
		let owed = false;
		for (const pending of this.pending.values()) if (pending.timer !== undefined && !pending.control) owed = true;
		if (!owed) this.progressDeadline = now + SESSION_WORKER_LIMITS.openMs;
		return Math.max(0, this.progressDeadline - now);
	}

	get activeCount(): number {
		return this.pending.size;
	}

	request(message: WorkerRequestInput): Promise<Reply> {
		if (this.closed) return Promise.reject(new Error("session_closing"));
		// A sealed secret answer is a human answer like a forwarded `extension_ui_response` (D11 secret phase 5.5).
		const control =
			message.type === "secret_sealed_answer" ||
			(message.type === "command" &&
				"type" in message.command &&
				typeof message.command.type === "string" &&
				["abort", "abort_bash", "extension_ui_response", "extension_ui_progress"].includes(message.command.type));
		const bytes = Buffer.byteLength(JSON.stringify(message));
		let count = 0;
		let pendingBytes = 0;
		for (const pending of this.pending.values()) {
			if (pending.control === control) {
				count++;
				pendingBytes += pending.bytes;
			}
		}
		const maxCount = control ? SESSION_WORKER_LIMITS.controlRequests : SESSION_WORKER_LIMITS.requests;
		const maxBytes = control ? SESSION_WORKER_LIMITS.controlBytes : SESSION_WORKER_LIMITS.requestBytes;
		if (count >= maxCount || pendingBytes + bytes > maxBytes)
			return Promise.reject(new Error("session_worker_request_limit"));
		const request = ++this.serial;
		return new Promise((resolve, reject) => {
			const timer =
				message.type === "command" && !control
					? undefined
					: setTimeout(this.timeout, control ? SESSION_WORKER_LIMITS.controlMs : this.progressBudgetMs());
			this.pending.set(request, { resolve, reject, bytes, control, timer });
			try {
				this.send({ ...message, request });
			} catch (cause) {
				this.pending.delete(request);
				clearTimeout(timer);
				reject(cause instanceof Error ? cause : new Error(String(cause)));
			}
		});
	}

	receive(message: Reply): void {
		const pending = this.pending.get(message.request);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending.delete(message.request);
		if (message.type === "result" && message.error) pending.reject(new Error(message.error));
		else pending.resolve(message);
	}

	close(error: Error): void {
		this.closed = true;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
}
