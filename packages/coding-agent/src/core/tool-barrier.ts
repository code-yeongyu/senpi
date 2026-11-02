/**
 * The session tool barrier (senpi#3717). A client that captures a pre-turn workspace checkpoint arms
 * the turn with a barrier, sends the prompt at once, and releases the barrier when its capture is
 * done. Until then a tool that may change the workspace waits in preflight; read-only tools do not.
 * The ceiling (`deadlineMs`) bounds the wait when a release never arrives.
 */

/** What a tool can do to the workspace. Tools that do not declare it are treated as `"write"`. */
export type ToolWorkspaceEffect = "read" | "write";

export interface ToolBarrierSpec {
	/** Client-chosen id that `releaseToolBarrier` must name; 1-256 characters. */
	readonly id: string;
	/** Ceiling in milliseconds after which the barrier opens by itself; an integer in 1..600000. */
	readonly deadlineMs: number;
}

export const MAX_TOOL_BARRIER_ID_LENGTH = 256;
export const MAX_TOOL_BARRIER_DEADLINE_MS = 600_000;

/** Why `value` is not a {@link ToolBarrierSpec}, or undefined when it is one. */
export function toolBarrierSpecError(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "toolBarrier must be an object { id, deadlineMs }.";
	}
	const { id, deadlineMs } = value as { id?: unknown; deadlineMs?: unknown };
	if (typeof id !== "string" || id.length === 0 || id.length > MAX_TOOL_BARRIER_ID_LENGTH) {
		return `toolBarrier.id must be a non-empty string of at most ${MAX_TOOL_BARRIER_ID_LENGTH} characters.`;
	}
	if (
		typeof deadlineMs !== "number" ||
		!Number.isSafeInteger(deadlineMs) ||
		deadlineMs < 1 ||
		deadlineMs > MAX_TOOL_BARRIER_DEADLINE_MS
	) {
		return `toolBarrier.deadlineMs must be a whole number of milliseconds in 1..${MAX_TOOL_BARRIER_DEADLINE_MS}.`;
	}
	return undefined;
}

interface ArmedBarrier {
	spec: ToolBarrierSpec;
	timer: ReturnType<typeof setTimeout>;
	readonly opened: Promise<void>;
	readonly open: () => void;
}

/** One pending wait: the barrier id it waits on and the promise that settles when it may proceed. */
export interface ToolBarrierWait {
	readonly id: string;
	readonly done: Promise<void>;
}

export class ToolBarrier {
	#armed: ArmedBarrier | undefined;
	readonly #onExpired: (spec: ToolBarrierSpec) => void;

	constructor(onExpired: (spec: ToolBarrierSpec) => void) {
		this.#onExpired = onExpired;
	}

	/** Arm, or re-arm under a new id and ceiling; calls already waiting keep waiting. */
	arm(spec: ToolBarrierSpec): void {
		const current = this.#armed;
		if (current) clearTimeout(current.timer);
		const { promise, resolve } = Promise.withResolvers<void>();
		const gate = current ?? { opened: promise, open: resolve };
		const timer = setTimeout(() => this.#expire(spec.id), spec.deadlineMs);
		timer.unref?.();
		this.#armed = { spec: { id: spec.id, deadlineMs: spec.deadlineMs }, timer, opened: gate.opened, open: gate.open };
	}

	/** Open the barrier armed under `id`. False when nothing with that id is armed (a no-op). */
	release(id: string): boolean {
		if (this.#armed?.spec.id !== id) return false;
		this.#open();
		return true;
	}

	/** The armed turn ended: open without reporting anything. */
	clear(): void {
		if (this.#armed) this.#open();
	}

	/** The wait a write tool must take now, or undefined when nothing is armed. Settles early on abort. */
	wait(signal: AbortSignal | undefined): ToolBarrierWait | undefined {
		const armed = this.#armed;
		if (!armed) return undefined;
		if (!signal) return { id: armed.spec.id, done: armed.opened };
		if (signal.aborted) return { id: armed.spec.id, done: Promise.resolve() };
		const aborted = Promise.withResolvers<void>();
		const onAbort = (): void => aborted.resolve();
		signal.addEventListener("abort", onAbort, { once: true });
		const done = Promise.race([armed.opened, aborted.promise]).finally(() =>
			signal.removeEventListener("abort", onAbort),
		);
		return { id: armed.spec.id, done };
	}

	#expire(id: string): void {
		const armed = this.#armed;
		if (armed?.spec.id !== id) return;
		this.#open();
		this.#onExpired(armed.spec);
	}

	#open(): void {
		const armed = this.#armed;
		if (!armed) return;
		this.#armed = undefined;
		clearTimeout(armed.timer);
		armed.open();
	}
}
