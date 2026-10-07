import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isBunBinary } from "../../config.ts";
import type { BrowserEngine } from "../../core/browser-engine.ts";
import type { PromptSurface } from "../../core/dynamic-prompt/types.ts";
import { createWebViewBroker } from "../../core/webview/webview-broker.ts";
import type { CliRuntimeConfiguration } from "../../main.ts";
import type { RpcConnectionOptions } from "./connection-handler.ts";
import type { RpcSessionBinding } from "./session-binding.ts";
import type { SessionEventWriter } from "./session-event-writer.ts";
import type { RpcSessionLaunchProfile } from "./session-registry.ts";
import type {
	HostToSessionWorker,
	SessionWorkerToHost,
	SessionWriteGrant,
	WorkerSnapshot,
} from "./session-worker-protocol.ts";

import { SessionWorkerRequests, type WorkerRequestInput } from "./session-worker-requests.ts";
import { acknowledge, acknowledgeGrant } from "./session-worker-signals.ts";

/** Lifecycle hooks the owning registry installs on every worker it allocates. */
export interface SessionWorkerCallbacks {
	reserve: (path: string) => SessionWriteGrant;
	/** Every snapshot republishes which paths this worker still writes. */
	reconcile: (livePaths: readonly string[]) => void;
	exit: () => void;
	failure: (error: string) => void;
}

/** Bun wrapper builders define the worker entry name relative to their explicit --root. */
declare const SENPI_RPC_SESSION_WORKER_ENTRY: string | undefined;
const compiledWorkerEntry =
	typeof SENPI_RPC_SESSION_WORKER_ENTRY === "string"
		? SENPI_RPC_SESSION_WORKER_ENTRY
		: "./src/modes/rpc/session-worker.ts";

export class SessionWorkerClient {
	/** The worker's own route to the main-thread Bun.WebView service; released when the worker exits. */
	private readonly webviewBroker = createWebViewBroker();
	readonly worker = new Worker(
		isBunBinary
			? fileURLToPath(new URL(compiledWorkerEntry, import.meta.url)).replaceAll("\\", "/")
			: new URL(import.meta.url.endsWith(".ts") ? "./session-worker.ts" : "./session-worker.js", import.meta.url),
		this.webviewBroker
			? { workerData: { webviewBroker: this.webviewBroker.port }, transferList: [this.webviewBroker.port] }
			: {},
	);
	readonly exited: Promise<void>;
	snapshot?: WorkerSnapshot;
	/** Main marks this only after installing the unique routing binding. */
	bindingReady = false;
	private readonly requests = new SessionWorkerRequests(
		(message) => this.worker.postMessage(message),
		() => this.fail("session_worker_request_timeout"),
	);
	private stopped = false;
	private closeTimer?: ReturnType<typeof setTimeout>;
	private writer?: SessionEventWriter;
	private sessionId?: string;
	private requestClose?: () => void;
	private options: Pick<RpcConnectionOptions, "capabilities" | "clientInfo"> = {};
	private readonly listeners = new Set<() => void>();
	private cancelUiPending = false;
	private terminalFailure?: string;

	private readonly callbacks: SessionWorkerCallbacks;

	constructor(callbacks: SessionWorkerCallbacks) {
		this.callbacks = callbacks;
		this.exited = new Promise((resolve) => {
			this.worker.once("exit", () => {
				if (!this.stopped && !this.closeTimer) this.fail("session_worker_exited");
				this.stopped = true;
				if (this.closeTimer) clearTimeout(this.closeTimer);
				this.requests.close(new Error("session_worker_exited"));
				void this.webviewBroker?.dispose();
				this.listeners.clear();
				callbacks.exit();
				this.publishTerminalFailure();
				resolve();
			});
		});
		this.worker.on("message", (message: SessionWorkerToHost) => this.receive(message));
		this.worker.on("error", (error: unknown) => this.fail(error instanceof Error ? error.message : String(error)));
	}

	async prepare(configuration: CliRuntimeConfiguration, profile: RpcSessionLaunchProfile): Promise<string> {
		const result = await this.request({ type: "prepare", configuration, profile });
		if (result.type !== "prepared") throw new Error("Invalid worker prepare response");
		return result.sessionPath;
	}

	/** Moves the worker's live session to another prompt surface (a later `open_session.promptSurface`). */
	async setPromptSurface(surface: PromptSurface): Promise<void> {
		const result = await this.request({ type: "prompt_surface", surface });
		if (result.type !== "result") throw new Error("Invalid worker prompt_surface response");
	}

	/** Moves the worker's live session to another browser engine (a later `open_session.browserEngine`). */
	async setBrowserEngine(engine: BrowserEngine): Promise<void> {
		const result = await this.request({ type: "browser_engine", engine });
		if (result.type !== "result") throw new Error("Invalid worker browser_engine response");
	}

	/** Moves the worker's live session to another permission preset (a later `open_session.permissionPreset`). */
	async setPermissionPreset(preset: string): Promise<void> {
		const result = await this.request({ type: "permission_preset", preset });
		if (result.type !== "result") throw new Error("Invalid worker permission_preset response");
	}

	async commit(): Promise<WorkerSnapshot> {
		const result = await this.request({ type: "commit" });
		if (result.type !== "ready") throw new Error("Invalid worker commit response");
		this.snapshot = result.snapshot;
		return result.snapshot;
	}

	async bind(
		sessionId: string,
		writer: SessionEventWriter,
		requestClose: () => void,
		options: Pick<RpcConnectionOptions, "capabilities" | "clientInfo">,
	): Promise<RpcSessionBinding> {
		this.sessionId = sessionId;
		this.writer = writer;
		this.requestClose = requestClose;
		this.options = options;
		await this.request({
			type: "bind",
			sessionId,
			capabilities: options.capabilities ?? [],
			connection: writer.currentConnection(),
		});
		return {
			handle: async (command) => {
				await this.request({ type: "command", command, connection: writer.currentConnection() });
			},
			cancelPendingExtensionUiRequests: () => this.post({ type: "cancel_ui" }),
			dispose: async () => {
				this.post({ type: "cancel_ui" });
			},
		};
	}

	get busy(): boolean {
		return this.requests.activeCount > 0 || this.snapshot?.busy === true;
	}

	get handoffBusy(): boolean {
		return this.requests.activeCount > 0 || (this.snapshot?.handoffBusy ?? this.snapshot?.busy) === true;
	}

	subscribeSettled(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Deadline requests termination, but only the actual exit callback releases ownership. */
	close(graceMs: number): Promise<void> {
		if (this.stopped || this.closeTimer) return this.exited;
		this.post({ type: "close" });
		this.closeTimer = setTimeout(() => this.quarantine(), graceMs);
		return this.exited;
	}

	quarantine(): void {
		this.stopped = true;
		this.requests.close(new Error("session_closing"));
		void this.worker.terminate();
	}

	private request(message: WorkerRequestInput): ReturnType<SessionWorkerRequests["request"]> {
		return this.requests.request(message);
	}

	private post(message: HostToSessionWorker): void {
		if (this.stopped) return;
		if (message.type === "cancel_ui") {
			if (this.cancelUiPending) return;
			this.cancelUiPending = true;
		}
		this.worker.postMessage(message);
	}

	private receive(message: SessionWorkerToHost): void {
		if (this.stopped) {
			if ("signal" in message) acknowledge(message.signal, false);
			return;
		}
		switch (message.type) {
			case "prepared":
			case "ready":
			case "result": {
				this.requests.receive(message);
				return;
			}
			case "reserve":
				acknowledgeGrant(message.signal, this.callbacks.reserve(message.path));
				return;
			case "snapshot":
				this.snapshot = message.snapshot;
				this.callbacks.reconcile(message.snapshot.liveSessionPaths);
				acknowledge(message.signal, true);
				if (message.settled) for (const listener of [...this.listeners]) listener();
				return;
			case "control_done":
				this.cancelUiPending = false;
				return;
			case "output": {
				const writer = this.writer;
				const sessionId = this.sessionId;
				if (!writer || !sessionId || this.stopped) {
					acknowledge(message.signal, false);
					return;
				}
				// Identity and activity commit before publication; clients may attach or disconnect on that event.
				if (message.snapshot) {
					this.snapshot = message.snapshot;
					this.callbacks.reconcile(message.snapshot.liveSessionPaths);
				} else if (this.snapshot)
					this.snapshot = {
						...this.snapshot,
						...message.activity,
						state: { ...this.snapshot.state, isStreaming: message.activity.streaming },
					};
				const enqueue = () => {
					if (!writer.enqueue(sessionId, message.record)) {
						acknowledge(message.signal, false);
						this.fail("session_output_overflow_or_closed");
						return Promise.reject(new Error("session_output_overflow_or_closed"));
					}
					return writer.waitForSessionBackpressure(sessionId);
				};
				const consumed =
					message.connection === undefined ? enqueue() : writer.withConnection(message.connection, enqueue);
				void consumed.then(
					() => acknowledge(message.signal, true),
					(cause: unknown) => {
						acknowledge(message.signal, false);
						this.fail(cause instanceof Error ? cause.message : String(cause));
					},
				);
				return;
			}
			case "capabilities":
				this.options.clientInfo?.setCapabilities(message.connection, message.capabilities);
				acknowledge(message.signal, true);
				return;
			case "request_close":
				this.requestClose?.();
				return;
			case "failure":
				this.fail(message.error);
				return;
		}
	}

	private fail(error: string): void {
		if (this.stopped) return;
		this.callbacks.failure(error);
		this.terminalFailure = error;
		if (this.writer && this.sessionId) {
			this.writer.enqueue(this.sessionId, { type: "session_error", error });
		}
		this.quarantine();
	}

	/** Terminal close records observe completed registry removal, including worker failure. */
	private publishTerminalFailure(): void {
		const error = this.terminalFailure;
		const writer = this.writer;
		const sessionId = this.sessionId;
		if (error === undefined || !writer || !sessionId) return;
		this.terminalFailure = undefined;
		writer.closeSession(
			sessionId,
			{
				type: "response",
				command: "close_session",
				success: false,
				error,
			},
			"error",
		);
	}
}
