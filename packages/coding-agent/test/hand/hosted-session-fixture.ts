// Shared fixture for the ST tests (senpi#6754): a hosted loop's side of the session port (its session record, what it
// carries with each call and how it commits what a call returns) and a hand process on the user's machine, joined by a
// brain's remote ToolHost over an in-process carrier.
import {
	type AgentToolCall,
	createRemoteExecutor,
	createRemoteToolHost,
	type RemoteSessionPort,
} from "@earendil-works/pi-agent-core";
import type { JsonValue, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "../../src/core/extensions/index.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import type { RelocationTarget } from "../../src/core/session-relocation.ts";
import type { SessionWake, SessionWakeChange } from "../../src/core/session-wakes.ts";
import { createLooplessHand } from "../../src/modes/rpc/remote-executor-scope.ts";
import { handConfiguration, type HandDirs, openLink } from "./remote-hand-fixture.ts";

export interface CommittedEffects {
	readonly entries?: { readonly customType: string; readonly data?: unknown }[];
	readonly activeTools?: string[];
	readonly documents?: Record<string, string | null>;
	readonly wakes?: SessionWakeChange[];
	readonly relocation?: { readonly target: string; readonly reason: string; readonly moveId: string };
}

export const toJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;

export const userMessage = (id: string, text: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: new Date(0).toISOString(),
	message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});

export interface HostedLoopOptions {
	readonly activeTools: string[];
	/** Carry the session's documents (the hand's session-dir stores); absent: the loop carries none. */
	readonly documents?: Record<string, string>;
	readonly wakes?: SessionWake[];
	readonly relocationTargets?: RelocationTarget[];
}

/**
 * The loop's side of the session port: its branch (the user's request first), the facts it carries with every call,
 * and the commit of what a call returns. A real loop appends each entry to its log and keeps documents, wakes and the
 * relocation request as its own session state; this one keeps them in memory.
 */
export function hostedLoop(options: HostedLoopOptions) {
	const sessionId = `hosted-${crypto.randomUUID()}`;
	const branch: SessionEntry[] = [userMessage("user-1", "plan the release")];
	const loop = {
		sessionId,
		branch,
		activeTools: options.activeTools,
		documents: options.documents === undefined ? undefined : { ...options.documents },
		wakes: [...(options.wakes ?? [])],
		moves: [] as NonNullable<CommittedEffects["relocation"]>[],
		committed: [] as { readonly toolCallId: string; readonly effects: CommittedEffects }[],
	};
	const commitDocuments = (changes: Record<string, string | null>) => {
		const documents = loop.documents ?? {};
		for (const [path, text] of Object.entries(changes))
			if (text === null) delete documents[path];
			else documents[path] = text;
		loop.documents = documents;
	};
	const commitWakes = (changes: SessionWakeChange[]) => {
		for (const change of changes) {
			const id = change.op === "arm" ? change.wake.id : change.id;
			loop.wakes = loop.wakes.filter((wake) => wake.id !== id);
			if (change.op === "arm") loop.wakes.push(change.wake);
		}
	};
	const port: RemoteSessionPort = {
		carry: () =>
			toJson({
				sessionId,
				idle: false,
				leafId: branch.at(-1)?.id ?? null,
				handEntries: branch.filter((entry) => entry.type === "custom"),
				branch,
				activeTools: loop.activeTools,
				...(loop.documents === undefined ? {} : { documents: loop.documents }),
				wakes: loop.wakes,
				...(options.relocationTargets === undefined ? {} : { relocation: { targets: options.relocationTargets } }),
			}),
		commit: (call: AgentToolCall, raw: JsonValue) => {
			const effects = raw as CommittedEffects;
			loop.committed.push({ toolCallId: call.id, effects });
			for (const entry of effects.entries ?? [])
				branch.push({
					type: "custom",
					id: `hand-${branch.length}`,
					parentId: branch.at(-1)?.id ?? null,
					timestamp: new Date(0).toISOString(),
					customType: entry.customType,
					data: entry.data,
				});
			if (effects.activeTools !== undefined) loop.activeTools = effects.activeTools;
			if (effects.documents !== undefined) commitDocuments(effects.documents);
			if (effects.wakes !== undefined) commitWakes(effects.wakes);
			if (effects.relocation !== undefined) loop.moves.push(effects.relocation);
		},
	};
	return { loop, port };
}

/** One hand process on the user's machine and the brain's link to it; `extra` adds extensions beside the builtins. */
export function userMachine(dirs: HandDirs, port: RemoteSessionPort, extra: ((pi: ExtensionAPI) => void)[] = []) {
	const link = openLink();
	const hand = createLooplessHand(handConfiguration(dirs), {
		twoSidedHome: "hand",
		...(extra.length === 0 ? {} : { extensionFactories: extra }),
	});
	const executor = createRemoteExecutor({
		authority: { kind: "self" },
		transport: link.hand,
		openScope: hand.openScope,
		onFault: (error) => {
			throw error;
		},
	});
	const host = createRemoteToolHost({ transport: link.brain, placement: "cross-machine", sessionPort: port });
	const scope = { id: `scope-${crypto.randomUUID()}`, root: dirs.cwd };
	return {
		call: async (id: string, name: string, args: Record<string, JsonValue>): Promise<ToolResultMessage> => {
			const { messages } = await host.execute(
				{ scope, calls: [{ type: "toolCall", id, name, arguments: args }], mode: "sequential" },
				{ emit: () => {} },
			);
			const [message] = messages;
			if (message === undefined) throw new Error(`no result for ${id}`);
			return message;
		},
		close: async () => {
			host.close();
			await executor.close();
			await hand.close();
		},
	};
}

export const textOf = (message: ToolResultMessage): string =>
	message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
