import { join } from "node:path";
import type { Api, Context, ImageContent, Message, Model, TextContent } from "@earendil-works/pi-ai";
import { frameHistoryImages } from "./cold-seed-images.ts";
import { appendSdkContentBlocks } from "./content-blocks.ts";
import type { HistoryTranscript } from "./history-transcript.lazy.ts";
import type { SeedTranscriptEntry } from "./history-transcript.ts";
import { sdkFailure, visibleSdkMessage } from "./long-context-retry.ts";
import { CONTINUE_TURN_INSTRUCTION } from "./prompt-bridge.ts";
import type { PromptCacheTtl } from "./prompt-cache-ttl.ts";
import { serializedPayloadBytes } from "./prompt-directive-dedupe.ts";
import type { ContentBlockParam, Options, SDKMessage, SessionStore } from "./sdk-boundary.ts";
import { isTransmittedMessage } from "./session-sync.ts";
import { mapPiToolNameToSdk } from "./tools.ts";

export type ColdSeedFrames = {
	sdkSessionId: string;
	entries: SeedTranscriptEntry[];
	/** Seeded assistant uuids keyed like a resident entry's `assistantUuidByIndex`: by sent user/tool-result count. */
	assistantUuidBySentCount: ReadonlyMap<number, string>;
	prompt: ContentBlockParam[];
	/** The seeded and prompt text the cold-seed budget counts, the same text-only measure as a flat replay. */
	estimateBlocks: ContentBlockParam[];
	payloadBytes: number;
};

export type ColdSeedFramesOptions = {
	sdkSessionId: string;
	cwd: string;
	model: Model<Api>;
	customToolNameToSdk: ReadonlyMap<string, string>;
	toolWatchNote?: string;
	cacheTtl?: PromptCacheTtl;
};

/**
 * Frames apply when there is history to seed and the turn ends on a new user message or on tool results (a continued
 * turn). Anything else keeps the flat replay.
 */
export function framesApply(context: Context): boolean {
	const final = context.messages.at(-1);
	if (final?.role !== "user" && final?.role !== "toolResult") return false;
	const history = final.role === "user" ? context.messages.slice(0, -1) : context.messages;
	return history.some((message) => message.role !== "configurationUpdate" && message.role !== "system");
}

/**
 * Where the Claude Code child keeps its transcripts: its `CLAUDE_CONFIG_DIR`, else `~/.claude` of its home. Undefined
 * when the child environment names neither, so a seed is never written to a guessed root.
 */
export function seedConfigDir(environment: Options["env"]): string | undefined {
	if (environment?.CLAUDE_CONFIG_DIR) return environment.CLAUDE_CONFIG_DIR;
	const home = environment?.HOME ?? (process.platform === "win32" ? environment?.USERPROFILE : undefined);
	return home ? join(home, ".claude") : undefined;
}

function withFrameImages(context: Context, historyLength: number, customToolNameToSdk: ReadonlyMap<string, string>) {
	const images = frameHistoryImages(context.messages.slice(0, historyLength), (name) =>
		mapPiToolNameToSdk(name, customToolNameToSdk),
	);
	return context.messages.map((message, index): Message => {
		const content = images.get(index) as (TextContent | ImageContent)[] | undefined;
		if (content === undefined || (message.role !== "user" && message.role !== "toolResult")) return message;
		return { ...message, content };
	});
}

function seededText(entries: readonly SeedTranscriptEntry[]): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];
	const push = (text: string | undefined): void => {
		if (text) blocks.push({ type: "text", text });
	};
	const visit = (value: unknown): void => {
		if (typeof value === "string") return push(value);
		if (Array.isArray(value)) return value.forEach(visit);
		if (typeof value !== "object" || value === null) return;
		const block = value as { type?: string; text?: string; thinking?: string; data?: string; name?: string };
		if (block.type === "text") push(block.text);
		else if (block.type === "thinking") push(block.thinking);
		else if (block.type === "redacted_thinking") push(block.data);
		else if (block.type === "tool_use")
			push(`${block.name ?? ""}${JSON.stringify((value as { input?: unknown }).input)}`);
		else if (block.type === "tool_result") visit((value as { content?: unknown }).content);
	};
	for (const entry of entries) visit(entry.message.content);
	return blocks;
}

/**
 * Builds a native-frame cold seed (senpi#1977). The history, with the frame image policy applied, becomes a seeded
 * transcript; the querying frame is the final user message, or `CONTINUE_TURN_INSTRUCTION` when the history ends on
 * tool results (Claude Code inserts its own one-line assistant before it). The tool-watch note rides on that frame.
 */
export function buildColdSeedFrames(
	historyTranscript: HistoryTranscript,
	context: Context,
	options: ColdSeedFramesOptions,
): ColdSeedFrames {
	const final = context.messages.at(-1);
	const finalUser = final?.role === "user" ? final : undefined;
	const historyLength = finalUser ? context.messages.length - 1 : context.messages.length;
	const seed = historyTranscript.buildSeedTranscript(
		{ ...context, messages: withFrameImages(context, historyLength, options.customToolNameToSdk) },
		{
			sessionId: options.sdkSessionId,
			cwd: options.cwd,
			model: options.model,
			customToolNameToSdk: options.customToolNameToSdk,
			...(options.cacheTtl === undefined ? {} : { cacheTtl: options.cacheTtl }),
		},
	);
	const assistantUuidBySentCount = new Map<number, string>();
	for (const [count, uuid] of seed.assistantUuidByIndex) {
		assistantUuidBySentCount.set(context.messages.slice(0, count).filter(isTransmittedMessage).length, uuid);
	}
	const prompt: ContentBlockParam[] = [];
	if (finalUser === undefined) prompt.push({ type: "text", text: CONTINUE_TURN_INSTRUCTION });
	else if (!appendSdkContentBlocks(prompt, finalUser.content))
		prompt.push({ type: "text", text: "(see attached image)" });
	if (options.toolWatchNote?.trim()) {
		prompt.push({
			type: "text",
			text: `<recovered_tool_results>\n${options.toolWatchNote.trim()}\n</recovered_tool_results>`,
		});
	}
	const estimateBlocks = [...seededText(seed.entries), ...prompt];
	return {
		sdkSessionId: options.sdkSessionId,
		entries: seed.entries,
		assistantUuidBySentCount,
		prompt,
		estimateBlocks,
		payloadBytes: serializedPayloadBytes(estimateBlocks),
	};
}

/** A session store that hands the SDK the seeded transcript for one resume and keeps nothing (the one-shot lane). */
export function seedSessionStore(frames: ColdSeedFrames): SessionStore {
	return {
		append: async () => {},
		load: async (key) => (key.sessionId === frames.sdkSessionId ? frames.entries : null),
	};
}

/** The API refused the seeded turns (their tool or thinking structure), or Claude Code could not find the seed. */
function isFramesSeedRejection(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	if (/no conversation found/i.test(text)) return true;
	return /invalid_request|\b400\b/i.test(text) && /tool_use|tool_result|thinking|signature/i.test(text);
}

/**
 * Runs `first`. When it carried a frames seed (`framesDispatched`) and that seed is rejected before anything visible
 * streamed, the attempt is closed and `fallback` runs once with the rejection; there is no second fallback. Messages
 * pass through as they arrive, and any other failure propagates unchanged.
 */
export async function* withFlatFallbackOnce(
	first: AsyncIterable<SDKMessage>,
	framesDispatched: () => boolean,
	fallback: (rejection: unknown) => AsyncIterable<SDKMessage>,
): AsyncGenerator<SDKMessage> {
	const iterator = first[Symbol.asyncIterator]();
	let rejection: { error: unknown } | undefined;
	let finished = false;
	try {
		let visible = false;
		for (;;) {
			let next: IteratorResult<SDKMessage>;
			try {
				next = await iterator.next();
			} catch (error) {
				finished = true;
				if (visible || !framesDispatched() || !isFramesSeedRejection(error)) throw error;
				rejection = { error };
				break;
			}
			if (next.done) {
				finished = true;
				return;
			}
			const failure = visible || !framesDispatched() ? undefined : sdkFailure(next.value);
			if (failure !== undefined && isFramesSeedRejection(failure)) {
				rejection = { error: failure };
				break;
			}
			visible ||= visibleSdkMessage(next.value);
			yield next.value;
		}
	} finally {
		if (!finished) {
			try {
				await iterator.return?.();
			} catch {
				// Closing the rejected attempt must never replace the rejection (or the error) that ended it.
			}
		}
	}
	if (rejection !== undefined) yield* fallback(rejection.error);
}
