import { MessageChannel, type MessagePort, type Transferable, Worker, type WorkerOptions } from "node:worker_threads";
import type { HostToKernelMessage, KernelToHostMessage } from "../../bridge/protocol.ts";
import {
	invocationSession,
	type InvocationSession,
	registerInvocationSession,
} from "../shared/invocation-authority.ts";
import type { WorkerRetirement } from "./interrupt-bounds.ts";
import type { CellAuthorityToken, JavaScriptKernelOptions } from "./kernel-contract.ts";
import type { KernelToolsInvokeOptions, KernelToolsInvokeRequest } from "./kernel-tools-types.ts";
import { type PermissionSession, registerPermissionKernel, unregisterPermissionKernel } from "./permission-sessions.ts";
import { forwardWorkerMessage, workerErrorFrame } from "./permission-worker-frames.ts";
import {
	createPermissionSlots,
	interruptPermissionSlots,
	type PermissionRequest,
	servePermissionSlot,
} from "./permission-slots.mjs";

export { revokeSessionKernels } from "./permission-sessions.ts";

type WorkerCommand =
	| { type: "check"; slot: number; generation: number }
	| { type: "retire" }
	| {
			type: "spawn";
			script: string;
			token?: string;
			port: MessagePort;
			options: WorkerOptions & { preload?: string | string[] };
	  };

export class KernelPermissionHost {
	readonly kernelId = crypto.randomUUID();
	readonly #options: JavaScriptKernelOptions;
	readonly #session: PermissionSession;
	readonly #retire: () => Promise<WorkerRetirement>;
	readonly #tokens = new Map<string, CellAuthorityToken>();
	readonly #runs = new Map<string, CellAuthorityToken>();
	readonly #invocations = new Map<string, CellAuthorityToken>();
	readonly #invokerBindings = new Map<string, number>();
	readonly #pools = new Set<SharedArrayBuffer>();
	readonly #ports = new Set<MessagePort>();
	readonly #children = new Map<Worker, Promise<void>>();
	readonly #releaseSession: () => void;
	#kernel: CellAuthorityToken;
	#revoked = false;
	#retiring?: Promise<void>;

	constructor(options: JavaScriptKernelOptions, retire: () => Promise<WorkerRetirement>) {
		this.#options = options;
		this.#retire = retire;
		this.#kernel = this.#mint();
		this.#session = registerPermissionKernel(options.sessionId, this);
		this.#releaseSession = registerInvocationSession(options.sessionId, () => this.#snapshot());
	}

	get blocked(): boolean {
		return this.#revoked || this.#session.dead || this.#session.pending !== undefined || this.#retiring !== undefined;
	}

	async admit(): Promise<void> {
		await this.#session.pending;
		await this.#retiring;
		this.assertSessionLive();
	}

	assertSessionLive(): void {
		if (this.#session.dead) throw new Error("Permission authority unavailable; restart the session");
	}

	#snapshot(): InvocationSession {
		return {
			cwd: this.#options.cwd,
			state: this.#options.permissions?.state() ?? { epoch: 0, active: false, rules: [] },
		};
	}

	#mint(
		signal?: AbortSignal,
		session = { sessionId: this.#options.sessionId, ...this.#snapshot() },
	): CellAuthorityToken {
		const { state } = session;
		if (!Number.isInteger(state.epoch) || state.epoch < 0 || state.epoch >= 2 ** 29)
			throw new Error("Invalid permission epoch");
		const authority = new SharedArrayBuffer(4);
		Atomics.store(new Int32Array(authority), 0, (state.epoch << 2) | 2 | Number(state.active));
		return {
			id: crypto.randomUUID(),
			sessionId: session.sessionId,
			cwd: session.cwd,
			authority,
			rules: state.rules,
			signal,
		};
	}

	/** Resolve host-only caller identity before admitting any invocation frame to the worker. */
	resolveInvocationToken(
		_request: KernelToolsInvokeRequest,
		options?: AbortSignal | KernelToolsInvokeOptions,
	): CellAuthorityToken {
		const signal = options && ("aborted" in options ? options : options.signal);
		const session = invocationSession(
			this.#options.sessionId,
			this.#snapshot(),
			options,
			this.#options.permissions?.resolveSession,
		);
		const token = this.#mint(signal, session);
		if (session.sessionId !== this.#options.sessionId) {
			const binding = registerPermissionKernel(session.sessionId, this);
			if (binding.dead || binding.pending) {
				if (!this.#invokerBindings.has(session.sessionId)) unregisterPermissionKernel(session.sessionId, this);
				throw new Error("Permission authority unavailable");
			}
			this.#invokerBindings.set(session.sessionId, (this.#invokerBindings.get(session.sessionId) ?? 0) + 1);
		}
		this.#tokens.set(token.id, token);
		return token;
	}

	invocation(request: KernelToolsInvokeRequest, options?: AbortSignal | KernelToolsInvokeOptions): () => void {
		const token = this.resolveInvocationToken(request, options);
		this.#invocations.set(request.call_id, token);
		const cancel = () => this.#kill(token);
		token.signal?.addEventListener("abort", cancel, { once: true });
		if (token.signal?.aborted) cancel();
		return () => {
			token.signal?.removeEventListener("abort", cancel);
			this.#invocations.delete(request.call_id);
			this.#release(token);
		};
	}

	frame(
		message: HostToKernelMessage,
	): HostToKernelMessage & { authority?: ReturnType<KernelPermissionHost["wireToken"]> } {
		let token: CellAuthorityToken | undefined;
		if (message.type === "run") {
			token = this.#mint();
			this.#tokens.set(token.id, token);
			this.#runs.set(message.cellId, token);
		} else if (message.type === "kernel-tool-invoke") {
			token = this.#invocations.get(message.call_id);
		} else if (message.type === "interrupt" || message.type === "close") {
			// An interrupt (including a timeout) ends work like settlement: inactive continuations survive.
			for (const token of this.#tokens.values()) {
				if (message.type === "interrupt") this.#release(token);
				else this.#kill(token);
			}
			for (const pool of this.#pools) interruptPermissionSlots(pool);
		}
		return token ? { ...message, authority: this.wireToken(token) } : message;
	}

	settle(message: KernelToHostMessage): void {
		if (message.type !== "result") return;
		const token = this.#runs.get(message.cellId);
		this.#runs.delete(message.cellId);
		if (token) this.#release(token);
	}

	#release(token: CellAuthorityToken): void {
		if (!this.#tokens.delete(token.id)) return;
		// Settled no-deny work keeps its async resources; the kernel word still revokes them. A live inactive
		// token also keeps its invoker binding, so that session's revocation reaches the work until the worker retires.
		const word = Atomics.load(new Int32Array(token.authority), 0);
		if (word & 2 && !(word & 1)) return;
		this.#kill(token);
		const count = this.#invokerBindings.get(token.sessionId);
		if (count === undefined) return;
		if (count > 1) this.#invokerBindings.set(token.sessionId, count - 1);
		else {
			this.#invokerBindings.delete(token.sessionId);
			unregisterPermissionKernel(token.sessionId, this);
		}
	}

	/** Worker retirement ends every continuation, so no invoker revocation needs to reach this kernel. */
	#unbindInvokers(): void {
		for (const sessionId of this.#invokerBindings.keys()) unregisterPermissionKernel(sessionId, this);
		this.#invokerBindings.clear();
	}

	#kill(token: CellAuthorityToken): void {
		Atomics.and(new Int32Array(token.authority), 0, ~2);
	}

	wireToken(token: CellAuthorityToken) {
		return { id: token.id, authority: token.authority, rules: token.rules };
	}

	bootstrap() {
		if (this.#revoked) {
			this.#kernel = this.#mint();
			this.#revoked = false;
		}
		return this.#channel();
	}

	#channel(token?: CellAuthorityToken) {
		const slots = createPermissionSlots();
		const { port1, port2 } = new MessageChannel();
		this.#pools.add(slots);
		this.#ports.add(port1);
		port1.on("message", (message: WorkerCommand) => {
			if (message.type === "check") {
				void servePermissionSlot(slots, message.slot, message.generation, (request) => this.#decide(request));
			} else if (message.type === "retire") {
				this.revoke();
				void this.retire();
			} else if (message.type === "spawn") {
				this.#spawnChild(message);
			}
		});
		port1.on("close", () => {
			this.#pools.delete(slots);
			this.#ports.delete(port1);
		});
		return {
			port: port2,
			slots,
			kernel: this.wireToken(this.#kernel),
			token: token && this.wireToken(token),
			cwd: this.#options.cwd,
		};
	}

	async #decide(request: PermissionRequest) {
		const token = this.#tokens.get(request.token);
		if (!token || this.#revoked || this.#session.dead || !(Atomics.load(new Int32Array(token.authority), 0) & 2)) {
			throw new Error("Permission authority unavailable");
		}
		const decide = this.#options.permissions?.decide;
		if (!decide) throw new Error("Cell decider unavailable");
		const answer = await decide(token, request.call);
		if (!(Atomics.load(new Int32Array(token.authority), 0) & 2)) throw new Error("Permission authority revoked");
		return answer;
	}

	#spawnChild(message: Extract<WorkerCommand, { type: "spawn" }>): void {
		const token = message.token ? this.#tokens.get(message.token) : undefined;
		if (this.blocked || (message.token && !token)) {
			message.port.close();
			return;
		}
		const permission = this.#channel(token);
		const messageKey = crypto.randomUUID();
		const { preload, ...workerOptions } = message.options;
		let worker: Worker;
		try {
			worker = new Worker(new URL("./permission-worker-entry.js", import.meta.url), {
				...workerOptions,
				workerData: {
					permission: { ...permission, messageKey },
					script: message.script,
					preload,
					userWorkerData: workerOptions.workerData,
				},
				transferList: [permission.port],
			});
		} catch (error) {
			permission.port.close();
			message.port.postMessage(workerErrorFrame(error));
			message.port.postMessage({ type: "exit" });
			message.port.close();
			return;
		}
		const exited = new Promise<void>((resolve) =>
			worker.once("exit", () => {
				message.port.postMessage({ type: "exit" });
				message.port.close();
				this.#children.delete(worker);
				resolve();
			}),
		);
		this.#children.set(worker, exited);
		worker.on("error", (error: Error) => message.port.postMessage(workerErrorFrame(error)));
		worker.on("online", () => message.port.postMessage({ type: "open" }));
		worker.on("message", (frame: unknown) => {
			if (
				frame !== null &&
				typeof frame === "object" &&
				"key" in frame &&
				frame.key === messageKey &&
				"value" in frame &&
				"transfer" in frame &&
				Array.isArray(frame.transfer)
			) {
				forwardWorkerMessage(message.port, frame.value, frame.transfer);
			} else forwardWorkerMessage(message.port, frame, []);
		});
		message.port.on("message", (frame: { type: string; value?: unknown; transfer?: Transferable[] }) => {
			if (frame.type === "terminate") void worker.terminate();
			else if (frame.type === "message") worker.postMessage(frame.value, frame.transfer);
		});
	}

	revoke(): void {
		this.#revoked = true;
		this.#kill(this.#kernel);
		for (const token of this.#tokens.values()) this.#kill(token);
		for (const pool of this.#pools) interruptPermissionSlots(pool);
	}

	retire(): Promise<void> {
		if (this.#retiring) return this.#retiring;
		const retirement = (async () => {
			let outcome: WorkerRetirement;
			try {
				outcome = await this.#retire();
			} catch {
				outcome = "abandoned";
			}
			if (outcome === "abandoned") this.#failed();
		})();
		this.#retiring = retirement;
		void retirement
			.finally(() => {
				if (this.#retiring === retirement) this.#retiring = undefined;
			})
			.catch(() => {});
		return retirement;
	}

	#failed(): void {
		this.#session.dead = true;
		this.#options.onRevocationFailed?.({ sessionId: this.#options.sessionId, kernelId: this.kernelId });
	}

	async terminateChildren(): Promise<void> {
		const children = [...this.#children];
		for (const [worker] of children) void worker.terminate();
		await Promise.all(children.map(([, exited]) => exited));
		for (const port of this.#ports) port.close();
		for (const token of this.#tokens.values()) this.#release(token);
		this.#unbindInvokers();
		this.#runs.clear();
	}

	dispose(): void {
		this.revoke();
		this.#releaseSession();
		this.#unbindInvokers();
		unregisterPermissionKernel(this.#options.sessionId, this);
	}
}
