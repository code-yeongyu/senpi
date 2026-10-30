import type { CallCounters, CallRaw, OutstandingCall } from "./compact-call-model.ts";
import type { CompactComponentRoots } from "./compact-component-roots.ts";
import type { CompactContentStore } from "./compact-content-store.ts";
import type { CompactSessionCalls } from "./compact-session-calls.ts";
import type { FrozenCompactState, MessageRoot } from "./compact-state-view.ts";
import { type FrozenBlock, readCompactBlocks } from "./compact-text-view.ts";
import { CompactValues, type ValueRef } from "./compact-values.ts";

export interface CallView extends Omit<OutstandingCall, "raw" | "hook" | "progress" | "result"> {
	readonly raw: string | null;
	readonly hook: unknown;
	readonly progress: unknown;
	readonly result: unknown;
}
export interface CallsView {
	readonly sequence: number;
	readonly calls: readonly CallView[];
	readonly counters: CallCounters;
}
interface Owner {
	readonly calls: CompactSessionCalls;
	readonly store: CompactContentStore;
	readonly blockRoots: CompactComponentRoots<FrozenBlock>;
	readonly messageRoots: CompactComponentRoots<MessageRoot>;
}

/** Whole-view assembly of the calls at a cut; a streaming call's raw prefix is read through the active message. */
export async function readCalls(frozen: FrozenCompactState, owner: Owner, valid: () => void): Promise<CallsView> {
	const values = new CompactValues(owner.store);
	const slot = async (ref: ValueRef | null) => (ref ? await values.read(ref) : null);
	const raw = async (address: CallRaw | null): Promise<string | null> => {
		if (!address) return null;
		if (address.kind === "owned") {
			let text = "";
			for await (const chunk of owner.store.text.chunks(address.root, valid)) text += chunk;
			for await (const chunk of owner.store.text.chunks(address.tailRoot, valid)) text += chunk;
			return text;
		}
		for await (const [, row] of owner.messageRoots.entries(frozen.active, valid)) {
			if (row.messageId !== address.messageId) continue;
			for await (const [, block] of owner.blockRoots.entries(row.blocks, valid))
				if (block.contentIndex === address.contentIndex)
					return (await readCompactBlocks(owner.store.text, [block], valid))[0].text;
		}
		return null;
	};
	const calls: CallView[] = [];
	for await (const [, call] of owner.calls.entries(frozen.calls.ref, valid))
		calls.push({
			...call,
			raw: await raw(call.raw),
			hook: await slot(call.hook),
			progress: await slot(call.progress),
			result: await slot(call.result),
		});
	valid();
	return { sequence: frozen.calls.sequence, calls, counters: frozen.calls.counters };
}
