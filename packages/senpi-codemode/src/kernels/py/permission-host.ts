import { closeSync, ftruncateSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerPermissionCheck } from "../../bridge/permission-check.ts";
import type { HostToKernelMessage } from "../../bridge/protocol.ts";
import type { CellAuthorityToken } from "../js/kernel-contract.ts";
import type { CellDecision, CellOperation } from "../js/permission-slots.mjs";
import type { KernelToolsInvokeOptions, KernelToolsInvokeRequest } from "../js/kernel-tools-types.ts";
import { registerPermissionKernel, unregisterPermissionKernel } from "../js/permission-sessions.ts";
import { invocationSession } from "../shared/invocation-authority.ts";
import type { PythonKernelStartOptions } from "./kernel-contract.ts";

const size = 1024 * 1024;
type BoundToken = { token: CellAuthorityToken; offset: number; release: () => void; abort: AbortController };

/** Python maps this host-owned file read-only. Words are published with one aligned eight-byte pwrite. */
export class PythonPermissionHost {
	readonly kernelId = crypto.randomUUID();
	readonly #root = mkdtempSync(join(tmpdir(), "senpi-py-authority-"));
	readonly #path = join(this.#root, "words");
	readonly #fd = openSync(this.#path, "wx+", 0o600);
	readonly #options: PythonKernelStartOptions;
	readonly #session;
	readonly #retire: () => Promise<void>;
	readonly #tokens = new Map<string, BoundToken>();
	readonly #runs = new Map<string, string>();
	readonly #invocations = new Map<string, string>();
	readonly #invokerBindings = new Map<string, number>();
	#offset = 8;
	#revoked = false;
	#disposed = false;

	constructor(options: PythonKernelStartOptions, retire: () => Promise<void>) {
		this.#options = options;
		this.#retire = retire;
		ftruncateSync(this.#fd, size);
		this.#session = registerPermissionKernel(options.sessionId, this);
		this.#publishKernel();
	}

	#state() {
		const state = this.#options.permissions?.state() ?? { epoch: 0, active: false, rules: [] };
		if (!Number.isInteger(state.epoch) || state.epoch < 0 || state.epoch >= 2 ** 29)
			throw new Error("Invalid permission epoch");
		return state;
	}
	#store(offset: number, word: number): void {
		const bytes = Buffer.alloc(8);
		bytes.writeBigUInt64LE(BigInt(word));
		if (writeSync(this.#fd, bytes, 0, 8, offset) !== 8) throw new Error("Permission authority publication failed");
	}
	#publishKernel(): void {
		const state = this.#state();
		this.#store(0, state.epoch * 4 + (this.#revoked ? 0 : 2) + Number(state.active));
	}
	async admit(): Promise<void> {
		await this.#session.pending;
		if (this.#session.dead || this.#disposed)
			throw new Error("Permission authority unavailable; restart the session");
	}
	bootstrap() {
		// A replacement is started only after the prior interpreter's exit was observed.
		this.interrupt();
		this.#offset = 8;
		this.#revoked = false;
		this.#publishKernel();
		return { path: this.#path, size, rules: this.#state().rules, runtime: process.versions.bun ? "bun" : "node" };
	}
	#mint(options?: AbortSignal | KernelToolsInvokeOptions): BoundToken {
		if (this.#revoked || this.#session.dead || this.#disposed) throw new Error("Permission authority unavailable");
		const session = invocationSession(
			this.#options.sessionId,
			{ cwd: this.#options.cwd, state: this.#state() },
			options,
			this.#options.permissions?.resolveSession,
		);
		if (this.#offset >= size) throw new Error("Python permission token capacity exhausted; reset the kernel");
		const authority = new SharedArrayBuffer(4);
		const word = session.state.epoch * 4 + 2 + Number(session.state.active);
		Atomics.store(new Int32Array(authority), 0, word);
		const abort = new AbortController();
		const token: CellAuthorityToken = {
			id: crypto.randomUUID(),
			sessionId: session.sessionId,
			cwd: session.cwd,
			authority,
			rules: session.state.rules,
			signal: abort.signal,
		};
		const offset = this.#offset;
		this.#offset += 8;
		this.#store(offset, word);
		const release = registerPermissionCheck(token.id, (call) => this.#decide(token, call));
		const bound = { token, offset, release, abort };
		if (session.sessionId !== this.#options.sessionId) {
			const binding = registerPermissionKernel(session.sessionId, this);
			if (binding.dead || binding.pending) {
				release();
				if (!this.#invokerBindings.has(session.sessionId)) unregisterPermissionKernel(session.sessionId, this);
				throw new Error("Permission authority unavailable");
			}
			this.#invokerBindings.set(session.sessionId, (this.#invokerBindings.get(session.sessionId) ?? 0) + 1);
		}
		this.#tokens.set(token.id, bound);
		return bound;
	}
	async #decide(token: CellAuthorityToken, call: CellOperation): Promise<CellDecision> {
		if (this.#revoked || this.#session.dead || !this.#tokens.has(token.id) || token.signal?.aborted)
			throw new Error("Permission authority unavailable");
		const decide = this.#options.permissions?.decide;
		if (!decide) throw new Error("Cell decider unavailable");
		const cancellation = Promise.withResolvers<never>();
		const cancel = () => cancellation.reject(new Error("Permission authority revoked"));
		token.signal?.addEventListener("abort", cancel, { once: true });
		try {
			const answer = await Promise.race([decide(token, call), cancellation.promise]);
			if (!this.#tokens.has(token.id) || token.signal?.aborted) throw new Error("Permission authority revoked");
			return answer;
		} finally {
			token.signal?.removeEventListener("abort", cancel);
		}
	}
	frame(message: HostToKernelMessage): HostToKernelMessage {
		let id: string | undefined;
		if (message.type === "run") {
			id = this.#mint().token.id;
			this.#runs.set(message.cellId, id);
		} else if (message.type === "kernel-tool-invoke") id = this.#invocations.get(message.call_id);
		else if (message.type === "interrupt" || message.type === "close") this.interrupt();
		const bound = id === undefined ? undefined : this.#tokens.get(id);
		return bound
			? Object.assign({}, message, {
					authority: {
						id,
						offset: bound.offset,
						rules: bound.token.rules,
						active: Boolean(Atomics.load(new Int32Array(bound.token.authority), 0) & 1),
					},
				})
			: message;
	}
	invocation(request: KernelToolsInvokeRequest, options?: AbortSignal | KernelToolsInvokeOptions): () => void {
		const bound = this.#mint(options);
		this.#invocations.set(request.call_id, bound.token.id);
		const signal = options && ("aborted" in options ? options : options.signal);
		const cancel = () => this.#release(bound.token.id);
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		return () => {
			signal?.removeEventListener("abort", cancel);
			this.#invocations.delete(request.call_id);
			cancel();
		};
	}
	settle(cellId: string): void {
		const id = this.#runs.get(cellId);
		this.#runs.delete(cellId);
		if (id) this.#release(id);
	}
	#release(id: string): void {
		const bound = this.#tokens.get(id);
		if (!bound) return;
		const word = Atomics.and(new Int32Array(bound.token.authority), 0, ~2) & ~2;
		this.#store(bound.offset, word);
		bound.abort.abort();
		bound.release();
		this.#tokens.delete(id);
		const count = this.#invokerBindings.get(bound.token.sessionId);
		if (count === 1) {
			this.#invokerBindings.delete(bound.token.sessionId);
			unregisterPermissionKernel(bound.token.sessionId, this);
		} else if (count !== undefined) this.#invokerBindings.set(bound.token.sessionId, count - 1);
	}
	interrupt(): void {
		for (const id of this.#tokens.keys()) this.#release(id);
	}
	revoke(): void {
		this.#revoked = true;
		this.#publishKernel();
		this.interrupt();
	}
	async retire(): Promise<void> {
		try {
			await this.#retire();
		} catch {
			this.#session.dead = true;
			this.#options.onRevocationFailed?.({ sessionId: this.#options.sessionId, kernelId: this.kernelId });
		}
	}
	dispose(): void {
		if (this.#disposed) return;
		this.revoke();
		this.#disposed = true;
		unregisterPermissionKernel(this.#options.sessionId, this);
		closeSync(this.#fd);
		rmSync(this.#root, { recursive: true, force: true });
	}
}
