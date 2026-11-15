/**
 * What a hand's loop-hook or tool call did to the loop's session beyond its result (session port, write), collected
 * during the call and sent back with its reply for the loop to do in turn.
 */
import type { ActiveToolsChange } from "../../core/hand/session-effects.ts";
import type { LoopHookCallFacts } from "../../core/extensions/runner.ts";
import type { SessionWakeChange } from "../../core/session-wakes.ts";
import type { SessionDocumentChanges } from "./session-documents.ts";
import type { RelocationRequestEffect } from "./session-port-hosts.ts";

/** A message a loop hook sent during its call, for the loop to send with the same options. */
export interface SentLoopMessage {
	readonly message: Parameters<LoopHookCallFacts["sendMessage"]>[0];
	readonly options?: Parameters<LoopHookCallFacts["sendMessage"]>[1];
}

/** An entry a loop hook appended during its call, for the loop to append to its own session (session port, write). */
export interface AppendedLoopEntry {
	readonly customType: string;
	readonly data?: unknown;
}

/** A user message a loop hook sent during its call, for the loop to send with the same options (session port, write). */
export interface SentLoopUserMessage {
	readonly content: Parameters<LoopHookCallFacts["sendUserMessage"]>[0];
	readonly options?: Parameters<LoopHookCallFacts["sendUserMessage"]>[1];
}

/** What a loop-hook call's handlers did beyond their result, which the loop does in turn (session port, write). */
export interface LoopHookEffects {
	readonly sent: SentLoopMessage[];
	readonly notices: LoopNotice[];
	readonly entries: AppendedLoopEntry[];
	readonly userMessages: SentLoopUserMessage[];
	/**
	 * The call's change to the active tool set (`pi.setActiveTools`), relative to the set it carried, so the changes of
	 * calls that ran at once compose when the loop applies each to its current set; unset: unchanged.
	 */
	activeTools: ActiveToolsChange | undefined;
	/** The documents the call changed, `null` for a removed one; unset: it carried none. */
	documents: SessionDocumentChanges | undefined;
	/** The call's changes to the loop's wakes, in order. */
	readonly wakes: SessionWakeChange[];
	/** The move the call asked for, which the loop applies when its turn ends. */
	relocation: RelocationRequestEffect | undefined;
	/** Settles what the call wrote into its session directory into {@link documents}; {@link effectsReply} awaits it. */
	settle: () => Promise<void>;
	/** Ends the call for its writes: from then on nothing more is collected here ({@link effectsReply} calls it). */
	seal: () => void;
}

/** A notice a loop hook showed during its call, for the loop to show on its own UI. */
export interface LoopNotice {
	readonly message: string;
	readonly type?: Parameters<LoopHookCallFacts["notify"]>[1];
}

export const emptyEffects = (): LoopHookEffects => ({
	sent: [],
	notices: [],
	entries: [],
	userMessages: [],
	activeTools: undefined,
	documents: undefined,
	wakes: [],
	relocation: undefined,
	settle: () => Promise.resolve(),
	seal: () => {},
});

/**
 * The effects a reply carries back to the loop, each only when there is one. Building it ends the call (`seal`) before
 * anything is read, so work still running afterwards is refused or goes to the call's late route, never collected into a reply
 * that was already built; then the session directory's changes are settled.
 */
export async function effectsReply(effects: LoopHookEffects): Promise<Record<string, unknown>> {
	effects.seal();
	await effects.settle();
	const { sent, notices, entries, userMessages, activeTools, documents, wakes, relocation } = effects;
	return {
		...(sent.length > 0 ? { sent } : {}),
		...(notices.length > 0 ? { notices } : {}),
		...(entries.length > 0 ? { entries } : {}),
		...(userMessages.length > 0 ? { userMessages } : {}),
		...(activeTools === undefined ? {} : { activeTools }),
		...(documents === undefined || Object.keys(documents).length === 0 ? {} : { documents }),
		...(wakes.length > 0 ? { wakes } : {}),
		...(relocation === undefined ? {} : { relocation }),
	};
}
