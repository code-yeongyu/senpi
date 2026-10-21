import type { EngineTurnHold } from "./engine-turn-hold.ts";
import type { CustomMessage } from "./messages.ts";

/** Input owns one release even when a command dispatches another prompt or a human steers mid-turn. */
export class EngineTurnInput {
	private pending:
		| {
				sources: Record<string, number>;
				wakes: ReturnType<EngineTurnHold["messages"]>;
				admitted: boolean;
				consumeAtSettlement: boolean;
		  }
		| undefined;
	private readonly hold: EngineTurnHold;

	constructor(hold: EngineTurnHold) {
		this.hold = hold;
	}

	get hasPending(): boolean {
		return this.pending !== undefined;
	}

	/**
	 * A release that ends a user Stop (senpi#3811) consumes its notices only when the delivering turn settles, so a
	 * newer Stop during that turn keeps them held for the next release.
	 */
	begin(options?: { readonly consumeAtSettlement?: boolean }): void {
		this.hold.attend();
		if (this.hold.releasing || this.pending || !this.hold.held) return;
		const wakes = this.hold.messages();
		const sources = this.hold.releaseAll("input");
		this.pending = { sources, wakes, admitted: false, consumeAtSettlement: options?.consumeAtSettlement === true };
	}

	messages(): CustomMessage[] {
		return this.pending?.admitted ? [] : (this.pending?.wakes.map((wake) => wake.message) ?? []);
	}

	admit(queued: boolean, enqueue: (message: CustomMessage) => void): void {
		const pending = this.pending;
		if (!pending || pending.admitted) return;
		if (pending.consumeAtSettlement) {
			if (queued) for (const wake of pending.wakes) enqueue(wake.message);
			pending.admitted = true;
			return;
		}
		for (const wake of pending.wakes) {
			if (this.hold.consume(wake.source, wake.noticeIds) && queued) enqueue(wake.message);
		}
		pending.admitted = true;
	}

	/**
	 * The one settle point, called once the session is quiescent (no prompt in flight, no run active):
	 * an admitted release finishes; one no input admitted (handled, no-op, thrown, cancelled, refused,
	 * an answer without a follow-on) is given back with custody intact.
	 */
	/** A newer Stop turned the input into held input: the released holds come back and nothing was admitted. */
	reject(): void {
		if (!this.pending) return;
		this.pending = undefined;
		this.hold.rejectInput();
	}

	/** `newerStop`: a Stop landed after this release began, so notices kept for settlement stay held. */
	async settle(
		release: (sources: Record<string, number>) => Promise<void>,
		options?: { readonly newerStop?: boolean },
	): Promise<void> {
		const pending = this.pending;
		if (!pending) return;
		this.pending = undefined;
		if (!pending.admitted) {
			this.hold.abandonRelease();
			return;
		}
		if (pending.consumeAtSettlement) {
			if (options?.newerStop === true) {
				this.hold.rejectInput();
				return;
			}
			for (const wake of pending.wakes) this.hold.consume(wake.source, wake.noticeIds);
		}
		const remaining = this.hold.finish();
		await release({ ...pending.sources, ...remaining });
	}
}
