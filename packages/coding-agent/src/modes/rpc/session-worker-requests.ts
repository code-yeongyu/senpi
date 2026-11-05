import {
	type HostToSessionWorker,
	SESSION_WORKER_LIMITS,
	type SessionWorkerToHost,
} from "./session-worker-protocol.ts";

type Request = Extract<HostToSessionWorker, { request: number }>;
type Reply = Extract<SessionWorkerToHost, { request: number }>;
/** Interrupts and human answers each keep their own bounded slots; sealed secret answers never take an abort's. */
type RequestClass = "normal" | "control" | "sealed";
export type WorkerRequestInput = Request extends infer T ? (T extends Request ? Omit<T, "request"> : never) : never;

/** Bounded request debt, with separate admission for interrupt and extension-UI responses. */
export class SessionWorkerRequests {
	private readonly pending = new Map<
		number,
		{
			resolve: (reply: Reply) => void;
			reject: (error: Error) => void;
			bytes: number;
			kind: RequestClass;
			timer?: ReturnType<typeof setTimeout>;
		}
	>();
	private serial = 0;
	private closed = false;
	/**
	 * Armed by the FIRST open message, never at construction. The open sequence (commit then
	 * bind) deliberately shares one budget - resetting it between them is what
	 * "does not reset the opening deadline between commit and bind" forbids - but a queue
	 * built long before its first open must not be charged for the wait, which is the
	 * silent instant timeout senpi#1719 reports on a loaded machine.
	 */
	private openingDeadline: number | undefined;
	private readonly send: (message: Request) => void;
	private readonly timeout: () => void;

	constructor(send: (message: Request) => void, timeout: () => void) {
		this.send = send;
		this.timeout = timeout;
	}

	/** Remaining share of the open budget, armed on first use so idle time before it is free. */
	private remainingOpenMs(): number {
		const now = Date.now();
		if (this.openingDeadline === undefined) this.openingDeadline = now + SESSION_WORKER_LIMITS.openMs;
		return Math.max(0, this.openingDeadline - now);
	}

	get activeCount(): number {
		return this.pending.size;
	}

	request(message: WorkerRequestInput): Promise<Reply> {
		if (this.closed) return Promise.reject(new Error("session_closing"));
		// A sealed secret answer is a human answer like a forwarded `extension_ui_response` (D11 secret phase 5.5), bounded
		// like one, but in its own class so holders answering at once cannot take an abort's slots.
		const kind: RequestClass =
			message.type === "secret_sealed_answer"
				? "sealed"
				: message.type === "command" &&
					  "type" in message.command &&
					  typeof message.command.type === "string" &&
					  ["abort", "abort_bash", "extension_ui_response", "extension_ui_progress"].includes(
							message.command.type,
					  )
					? "control"
					: "normal";
		const control = kind !== "normal";
		const bytes = Buffer.byteLength(JSON.stringify(message));
		let count = 0;
		let pendingBytes = 0;
		for (const pending of this.pending.values()) {
			if (pending.kind === kind) {
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
					: setTimeout(this.timeout, control ? SESSION_WORKER_LIMITS.controlMs : this.remainingOpenMs());
			this.pending.set(request, { resolve, reject, bytes, kind, timer });
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
