import type { Socket } from "node:net";
import { win32 } from "node:path";

export type HerdrMethod =
	| "pane.report_agent"
	| "pane.report_metadata"
	| "pane.report_agent_session"
	| "pane.release_agent";
interface HerdrRequest {
	id: string;
	method: HerdrMethod;
	params: Record<string, unknown>;
}
interface QueuedRequest {
	request: HerdrRequest;
	resolve: () => void;
	reject: (error: Error) => void;
}

// Shared across runtime replacements: a reload in the same millisecond must not
// restart below the previous instance's sequence, even when the clock goes back.
let sequence = 0;

export function herdrSocketTarget(path: string, platform = process.platform): string {
	return platform !== "win32" || /^\\\\[.?]\\pipe\\/i.test(path) ? path : win32.join("\\\\.\\pipe\\", path);
}

export class HerdrClient {
	private readonly queue: QueuedRequest[] = [];
	private draining = false;
	private readonly target: string;
	private readonly paneId: string;
	private readonly now: () => number;
	private readonly connect: (path: string) => Socket;

	constructor(socketPath: string, paneId: string, deps: { now: () => number; connect: (path: string) => Socket }) {
		this.target = herdrSocketTarget(socketPath);
		this.paneId = paneId;
		this.now = deps.now;
		this.connect = deps.connect;
	}

	send(method: HerdrMethod, params: Record<string, unknown>): Promise<void> {
		sequence = Math.max(sequence + 1, this.now() * 1000);
		const request: HerdrRequest = {
			id: `custom:senpi:${sequence}`,
			method,
			params: { ...params, pane_id: this.paneId, source: "custom:senpi", seq: sequence },
		};
		return new Promise((resolve, reject) => {
			this.queue.push({ request, resolve, reject });
			void this.drain();
		});
	}

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const next = this.queue.shift()!;
				if ((await this.attempt(next.request, 500)) || (await this.attempt(next.request, 1500))) next.resolve();
				else next.reject(new Error(`Herdr request failed after two attempts: ${next.request.method}`));
			}
		} finally {
			this.draining = false;
		}
	}

	private attempt(request: HerdrRequest, timeoutMs: number): Promise<boolean> {
		return new Promise((resolve) => {
			let socket: Socket;
			try {
				socket = this.connect(this.target);
			} catch {
				resolve(false);
				return;
			}
			let finished = false;
			let buffer = "";
			const finish = (success: boolean) => {
				if (finished) return;
				finished = true;
				clearTimeout(timeout);
				socket.destroy();
				resolve(success);
			};
			const timeout = setTimeout(() => finish(false), timeoutMs);
			timeout.unref();
			socket.on("error", () => finish(false));
			socket.on("end", () => finish(false));
			socket.on("close", () => finish(false));
			socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
			socket.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				if (buffer.length > 65_536) {
					finish(false);
					return;
				}
				const newline = buffer.indexOf("\n");
				if (newline < 0) return;
				try {
					const response: unknown = JSON.parse(buffer.slice(0, newline));
					finish(
						typeof response === "object" &&
							response !== null &&
							"id" in response &&
							response.id === request.id &&
							"result" in response &&
							!("error" in response),
					);
				} catch {
					finish(false);
				}
			});
		});
	}
}
