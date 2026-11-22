import {
	type CancelReceipt,
	EvalHandleError,
	type EvalHandleHost,
	type HandleCallContext,
	type HandleOutcome,
	type HandleRef,
	type HandleSnapshot,
	type HandleWatch,
	type OutputRequest,
	type OutputSnapshot,
} from "@code-yeongyu/senpi";
import { CompletionHandles, type CompletionStart } from "./completion-handles.ts";
import { refKey } from "./handle-args.ts";
import { mergeWatches } from "./watch-queue.ts";

/** What a bridge call brings along: the session's host capability (if any) and the calling cell's signal. */
export interface HandleBackend {
	readonly host: EvalHandleHost | undefined;
	readonly signal: AbortSignal | undefined;
}

export interface HandleRegistryOptions {
	/** The agent session that owns this registry; every host call is fenced with it. */
	readonly ownerSessionId: string;
	readonly now?: () => number;
}

/**
 * One registry per session generation (created at `session_start`, disposed in `dropRuntime`). Agent and
 * workpool refs are routed to the session's `EvalHandleHost`; completion refs are codemode's own in-flight
 * completions. After disposal every ref fails closed with `eval_handle_stale` before any host is touched.
 */
export class HandleRegistry {
	readonly ownerSessionId: string;
	readonly #completions: CompletionHandles;
	readonly #open = new Set<HandleWatch>();
	#disposed = false;

	constructor(options: HandleRegistryOptions) {
		this.ownerSessionId = options.ownerSessionId;
		this.#completions = new CompletionHandles(options.now);
	}

	get disposed(): boolean {
		return this.#disposed;
	}

	get openWatches(): number {
		return this.#open.size;
	}

	get openCompletionWatches(): number {
		return this.#completions.openWatches;
	}

	startCompletion(input: CompletionStart): HandleRef {
		this.#assertLive();
		return this.#completions.start(input);
	}

	async watch(refs: readonly HandleRef[], backend: HandleBackend): Promise<HandleWatch> {
		this.#assertLive();
		const local = refs.filter((ref) => this.#completions.owns(ref));
		const remote = refs.filter((ref) => !this.#completions.owns(ref));
		const host = remote.length > 0 ? this.#requireHost(backend, remote) : undefined;
		const parts: HandleWatch[] = [];
		if (local.length > 0) parts.push(this.#completions.watch(local));
		if (host !== undefined) {
			try {
				parts.push(await host.watch(remote, this.#callContext(backend)));
			} catch (error) {
				for (const part of parts) part.close();
				throw error;
			}
		}
		const byKey = new Map(parts.flatMap((part) => part.initial.map((snapshot) => [refKey(snapshot.ref), snapshot])));
		const ordered = refs.map((ref) => {
			const snapshot = byKey.get(refKey(ref));
			if (snapshot === undefined) throw new EvalHandleError("eval_handle_not_found", `no snapshot for ${ref.id}`);
			return snapshot;
		});
		const merged = mergeWatches(ordered, parts);
		const tracked: HandleWatch = {
			initial: merged.initial,
			updates: merged.updates,
			close: () => {
				merged.close();
				this.#open.delete(tracked);
			},
		};
		this.#open.add(tracked);
		if (this.#disposed) tracked.close();
		return tracked;
	}

	async status(ref: HandleRef, backend: HandleBackend): Promise<HandleSnapshot> {
		const watch = await this.watch([ref], backend);
		try {
			const snapshot = watch.initial[0];
			if (snapshot === undefined) throw new EvalHandleError("eval_handle_not_found", `no snapshot for ${ref.id}`);
			return snapshot;
		} finally {
			watch.close();
		}
	}

	async result(ref: HandleRef, backend: HandleBackend): Promise<HandleOutcome> {
		this.#assertLive();
		if (this.#completions.owns(ref)) return this.#completions.result(ref);
		return await this.#requireHost(backend, [ref]).result(ref, this.#callContext(backend));
	}

	async send(ref: HandleRef, message: string, backend: HandleBackend): Promise<HandleSnapshot> {
		this.#assertLive();
		if (this.#completions.owns(ref)) {
			throw new EvalHandleError("eval_handle_operation_unsupported", "send() is for agent handles only");
		}
		return await this.#requireHost(backend, [ref]).send(ref, message, this.#callContext(backend));
	}

	async cancel(ref: HandleRef, backend: HandleBackend): Promise<CancelReceipt> {
		this.#assertLive();
		if (this.#completions.owns(ref)) return this.#completions.cancel(ref);
		return await this.#requireHost(backend, [ref]).cancel(ref, this.#callContext(backend));
	}

	async output(ref: HandleRef, request: OutputRequest, backend: HandleBackend): Promise<OutputSnapshot> {
		this.#assertLive();
		if (this.#completions.owns(ref)) return this.#completions.output(ref, request);
		return await this.#requireHost(backend, [ref]).output(ref, request, this.#callContext(backend));
	}

	/** Closes every open watch and aborts every in-flight completion; later calls fail with `eval_handle_stale`. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const watch of [...this.#open]) watch.close();
		this.#open.clear();
		this.#completions.dispose();
	}

	#assertLive(): void {
		if (this.#disposed) {
			throw new EvalHandleError("eval_handle_stale", "this session generation was dropped; its handles are gone");
		}
	}

	#requireHost(backend: HandleBackend, refs: readonly HandleRef[]): EvalHandleHost {
		if (backend.host !== undefined) return backend.host;
		const kinds = [...new Set(refs.map((ref) => ref.kind))].join("/");
		throw new EvalHandleError(
			"eval_wait_unavailable",
			`wait()/handle() over ${kinds} work is not supported by this runtime: no EvalHandleHost is provided for this session`,
		);
	}

	#callContext(backend: HandleBackend): HandleCallContext {
		return {
			ownerSessionId: this.ownerSessionId,
			...(backend.signal === undefined ? {} : { signal: backend.signal }),
		};
	}
}
