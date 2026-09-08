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
	private readonly openingDeadline = Date.now() + SESSION_WORKER_LIMITS.openMs;
	private readonly send: (message: Request) => void;
	private readonly timeout: () => void;

	constructor(send: (message: Request) => void, timeout: () => void) {
		this.send = send;
		this.timeout = timeout;
	}

	get activeCount(): number {
		return this.pending.size;
	}

	request(message: WorkerRequestInput): Promise<Reply> {
		if (this.closed) return Promise.reject(new Error("session_closing"));
		const control =
			message.type === "command" &&
			"type" in message.command &&
			typeof message.command.type === "string" &&
			["abort", "abort_bash", "extension_ui_response"].includes(message.command.type);
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
					: setTimeout(
							this.timeout,
							control ? SESSION_WORKER_LIMITS.controlMs : Math.max(0, this.openingDeadline - Date.now()),
						);
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
