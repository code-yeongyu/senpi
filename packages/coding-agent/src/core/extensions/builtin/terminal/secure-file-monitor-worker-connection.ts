import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
	deliverSecureWorkerEvent,
	parseSecureWorkerResponse,
	sanitizeSecureWorkerEnvironment,
} from "./secure-file-monitor-worker-boundary.ts";
import { resolveDefaultWorkerCommand } from "./secure-file-monitor-worker-command.ts";
import { disposeSecureWorkerProcess } from "./secure-file-monitor-worker-process.ts";
import type {
	RegisterSecureFileMonitorOptions,
	SecureFileMonitorWorkerPoolOptions,
	SecureFileMonitorWorkerRegistration,
	SecureWorkerRequestSuccessType,
	SecureWorkerResponse,
} from "./secure-file-monitor-worker-protocol.ts";

const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const MAX_PROTOCOL_LINE_LENGTH = 64 * 1024;

type PendingRequest = {
	readonly expectedType: SecureWorkerRequestSuccessType;
	readonly reject: (error: Error) => void;
	readonly resolve: () => void;
	readonly timer: ReturnType<typeof setTimeout>;
};

export class SecureFileMonitorWorkerConnection {
	readonly #child: ChildProcessWithoutNullStreams;
	readonly #events = new Map<string, RegisterSecureFileMonitorOptions["onEvent"]>();
	readonly #exit: Promise<void>;
	readonly #onError: ((error: Error) => void) | undefined;
	readonly #pending = new Map<number, PendingRequest>();
	readonly #ready: Promise<{ readonly device: bigint; readonly inode: bigint }>;
	readonly #requestTimeoutMs: number;
	#disposePromise: Promise<void> | undefined;
	#disposing = false;
	#nextId = 1;
	#nextRequestId = 1;
	#poisoned = false;

	constructor(directory: string, options: SecureFileMonitorWorkerPoolOptions) {
		this.#onError = options.onError;
		this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const [executable, ...args] = options.workerCommand ?? resolveDefaultWorkerCommand();
		this.#child = spawn(executable, args, {
			cwd: directory,
			env: sanitizeSecureWorkerEnvironment(),
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.#exit = new Promise((resolve) => this.#child.once("exit", () => resolve()));
		this.#ready = this.#listenForReady(options.startupTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
		this.#child.stdin.on("error", (error) => this.#retire(error));
		this.#child.once("exit", (code, signal) => {
			const suffix = signal ? ` with signal ${signal}` : ` with code ${code ?? "unknown"}`;
			const error = new Error(`Secure file monitor worker exited${suffix}.`);
			this.#rejectPending(error);
			if (!this.#disposing) {
				for (const onEvent of this.#events.values()) {
					deliverSecureWorkerEvent(
						onEvent,
						{ type: "error", message: "secure worker stopped unexpectedly" },
						this.#onError,
					);
				}
			}
			this.#events.clear();
		});
	}

	async verify(expectedDevice: bigint, expectedInode: bigint): Promise<void> {
		const actual = await this.#ready;
		if (actual.device !== expectedDevice || actual.inode !== expectedInode) {
			await this.dispose();
			throw new Error("The approved monitor parent changed before secure worker startup.");
		}
	}

	async register(
		options: Omit<RegisterSecureFileMonitorOptions, "directory" | "expectedDevice" | "expectedInode">,
	): Promise<SecureFileMonitorWorkerRegistration> {
		const id = `secure_${this.#nextId++}`;
		this.#events.set(id, options.onEvent);
		try {
			await this.#request("register", "registered", {
				id,
				targetName: options.targetName,
				event: options.event,
				timeoutMs: options.timeoutMs,
			});
		} catch (error) {
			this.#events.delete(id);
			throw error;
		}
		let stopped = false;
		return {
			reconcile: () => this.#request("reconcile", "reconciled", { id }),
			stop: async () => {
				if (stopped) return;
				stopped = true;
				this.#events.delete(id);
				if (this.#poisoned || this.#child.exitCode !== null || this.#child.stdin.destroyed) return;
				await this.#request("cancel", "cancelled", { id });
			},
		};
	}

	async dispose(): Promise<void> {
		if (!this.#disposePromise) {
			this.#disposing = true;
			this.#disposePromise = disposeSecureWorkerProcess(this.#child, this.#exit, this.#requestTimeoutMs);
		}
		return await this.#disposePromise;
	}

	#listenForReady(timeoutMs: number): Promise<{ readonly device: bigint; readonly inode: bigint }> {
		return new Promise((resolveReady, rejectReady) => {
			let settled = false;
			const settleFailure = (error: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				rejectReady(error);
			};
			const timer = setTimeout(() => {
				settleFailure(new Error("Secure file monitor worker did not become ready before the startup deadline."));
				this.#child.kill();
			}, timeoutMs);
			timer.unref();
			this.#child.once("error", (error) => settleFailure(error));
			this.#child.once("exit", () => settleFailure(new Error("Secure file monitor worker exited before startup.")));
			createInterface({ input: this.#child.stdout }).on("line", (line) => {
				if (line.length > MAX_PROTOCOL_LINE_LENGTH) {
					const error = new Error("Secure file monitor worker exceeded the protocol line limit.");
					settleFailure(error);
					this.#retire(error);
					return;
				}
				let response: SecureWorkerResponse;
				try {
					response = parseSecureWorkerResponse(line);
				} catch (error) {
					const failure = error instanceof Error ? error : new Error(String(error));
					settleFailure(failure);
					this.#retire(failure);
					return;
				}
				if (response.type === "ready" && !settled) {
					try {
						const device = BigInt(response.device);
						const inode = BigInt(response.inode);
						settled = true;
						clearTimeout(timer);
						resolveReady({ device, inode });
					} catch (error) {
						const failure = error instanceof Error ? error : new Error(String(error));
						settleFailure(failure);
						this.#retire(failure);
					}
				} else if (response.type === "event") {
					const onEvent = this.#events.get(response.id);
					this.#events.delete(response.id);
					if (onEvent) deliverSecureWorkerEvent(onEvent, response.event, this.#onError);
				} else if (response.type !== "ready") {
					this.#settleRequest(response);
				} else {
					this.#retire(new Error("Secure file monitor worker sent an unexpected ready response."));
				}
			});
		});
	}

	#request(type: string, expectedType: SecureWorkerRequestSuccessType, body: Record<string, unknown>): Promise<void> {
		if (this.#poisoned || this.#child.exitCode !== null || this.#child.stdin.destroyed) {
			return Promise.reject(new Error("Secure file monitor worker already exited."));
		}
		const requestId = this.#nextRequestId++;
		return new Promise((resolveRequest, rejectRequest) => {
			const timer = setTimeout(() => {
				this.#pending.delete(requestId);
				const error = new Error(`Secure file monitor worker ${type} request timed out.`);
				rejectRequest(error);
				this.#retire(error);
			}, this.#requestTimeoutMs);
			timer.unref();
			this.#pending.set(requestId, { expectedType, resolve: resolveRequest, reject: rejectRequest, timer });
			this.#child.stdin.write(`${JSON.stringify({ type, requestId, ...body })}\n`, (error) => {
				if (!error) return;
				const pending = this.#pending.get(requestId);
				if (!pending) return;
				this.#pending.delete(requestId);
				clearTimeout(pending.timer);
				pending.reject(error);
				this.#retire(error);
			});
		});
	}

	#retire(error: Error): void {
		if (this.#poisoned || this.#disposing) return;
		this.#poisoned = true;
		this.#rejectPending(error);
		for (const onEvent of this.#events.values()) {
			deliverSecureWorkerEvent(onEvent, { type: "error", message: error.message }, this.#onError);
		}
		this.#events.clear();
		this.#child.kill();
	}

	#settleRequest(response: Exclude<SecureWorkerResponse, { readonly type: "event" | "ready" }>): void {
		const pending = this.#pending.get(response.requestId);
		if (!pending) {
			this.#retire(new Error(`Secure file monitor worker sent an unknown request id: ${response.requestId}`));
			return;
		}
		this.#pending.delete(response.requestId);
		clearTimeout(pending.timer);
		if (response.type === "request_error") {
			pending.reject(new Error(response.message));
			return;
		}
		if (response.type !== pending.expectedType) {
			const error = new Error(
				`Secure file monitor worker sent unexpected response ${response.type}; expected ${pending.expectedType}.`,
			);
			pending.reject(error);
			this.#retire(error);
			return;
		}
		pending.resolve();
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}
}
