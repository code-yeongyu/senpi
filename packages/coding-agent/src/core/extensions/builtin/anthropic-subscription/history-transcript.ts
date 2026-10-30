import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import { type AnthropicMessageParams, toAnthropicMessageParams } from "@earendil-works/pi-ai/api/anthropic-messages";
import { bundledClaudeCodeVersion } from "./executable-version.ts";
import type { PromptCacheTtl } from "./prompt-cache-ttl.ts";
import { mapPiToolNameToSdk } from "./tools.ts";

type MessageParam = AnthropicMessageParams["messages"][number];
type ContentBlock = Exclude<MessageParam["content"], string>[number];

export type SeedAssistantMessage = {
	id: string;
	type: "message";
	role: "assistant";
	model: string;
	content: ContentBlock[];
	stop_reason: "tool_use" | "end_turn";
	stop_sequence: null;
	usage: { input_tokens: 0; output_tokens: 0 };
};

export type SeedUserMessage = { role: "user"; content: MessageParam["content"] };

/** One chain entry of a Claude Code session transcript (`projects/<project>/<session>.jsonl`). */
export type SeedTranscriptEntry = {
	parentUuid: string | null;
	isSidechain: false;
	type: "user" | "assistant";
	message: SeedUserMessage | SeedAssistantMessage;
	uuid: string;
	timestamp: string;
	userType: "external";
	entrypoint: "sdk-ts";
	cwd: string;
	sessionId: string;
	version: string;
	sourceToolAssistantUUID?: string;
};

export type SeedTranscriptOptions = {
	sessionId: string;
	cwd: string;
	/** The model the seeded session runs on; assistant messages from it keep their signed thinking. */
	model: Model<Api>;
	customToolNameToSdk?: ReadonlyMap<string, string>;
	/** Lifetime of the one senpi breakpoint at the tail of the history; without it no breakpoint is written. */
	cacheTtl?: PromptCacheTtl;
};

export type SeedTranscript = {
	entries: SeedTranscriptEntry[];
	/** Seeded assistant uuids keyed by the count of context messages up to and including that assistant. */
	assistantUuidByIndex: ReadonlyMap<number, string>;
	/** UTF-8 bytes of the seeded messages, serialized. */
	payloadBytes: number;
};

/** Claude Code shortens a project directory name past this length and appends a hash of the full path. */
const MAX_PROJECT_DIR_NAME_LENGTH = 200;

const SOURCE_COUNT = Symbol("seedSourceCount");
type TaggedAssistantMessage = AssistantMessage & { [SOURCE_COUNT]?: number };

function deterministicUuid(...parts: string[]): string {
	const hex = createHash("sha256").update(parts.join("\0")).digest("hex");
	const variant = ((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function isReplayable(message: Message): boolean {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function withSdkToolNames(
	content: MessageParam["content"],
	customToolNameToSdk: ReadonlyMap<string, string> | undefined,
): MessageParam["content"] {
	if (typeof content === "string") return content;
	return content.map((block) =>
		block.type === "tool_use" ? { ...block, name: mapPiToolNameToSdk(block.name, customToolNameToSdk) } : block,
	);
}

/** Claude Code drops a breakpoint set on an image, so the last text or tool_result block carries it. */
function withTailBreakpoint(content: MessageParam["content"], ttl: PromptCacheTtl): MessageParam["content"] {
	const cacheControl = { type: "ephemeral" as const, ttl };
	if (typeof content === "string") return [{ type: "text", text: content, cache_control: cacheControl }];
	for (let index = content.length - 1; index >= 0; index--) {
		const block = content[index];
		if (block?.type !== "text" && block?.type !== "tool_result") continue;
		const marked = [...content];
		marked[index] = { ...block, cache_control: cacheControl };
		return marked;
	}
	return content;
}

function hasToolUse(content: MessageParam["content"]): boolean {
	return typeof content !== "string" && content.some((block) => block.type === "tool_use");
}

function hasToolResult(content: MessageParam["content"]): boolean {
	return typeof content !== "string" && content.some((block) => block.type === "tool_result");
}

/**
 * Build the history of `context` as a Claude Code session transcript, so a query resumed from it sends the history as
 * native turns: tool calls as `tool_use`, results as `tool_result` with their images, and thinking per the Anthropic
 * replay rules (`toAnthropicMessageParams`). A final user message is not seeded; it is the prompt of the resumed
 * query. Pure and deterministic: the same history and options give byte-identical entries.
 */
export function buildSeedTranscript(context: Context, options: SeedTranscriptOptions): SeedTranscript {
	const finalMessage = context.messages.at(-1);
	const historyLength = finalMessage?.role === "user" ? context.messages.length - 1 : context.messages.length;
	const history: Message[] = [];
	for (let index = 0; index < historyLength; index++) {
		const message = context.messages[index];
		if (message === undefined || !isReplayable(message)) continue;
		if (message.role !== "assistant") {
			history.push(message);
			continue;
		}
		// The count rides on a symbol key: transformMessages copies messages with object spread, which keeps it.
		const tagged: TaggedAssistantMessage = { ...message };
		tagged[SOURCE_COUNT] = index + 1;
		history.push(tagged);
	}

	const converted = toAnthropicMessageParams(history, options.model, { preserveThinking: true });
	const version = bundledClaudeCodeVersion() ?? "unknown";
	const entries: SeedTranscriptEntry[] = [];
	const assistantUuidByIndex = new Map<number, string>();
	let timestampMs = history[0]?.timestamp ?? 0;
	let parentUuid: string | null = null;
	let lastAssistantUuid: string | undefined;

	for (const [paramIndex, param] of converted.messages.entries()) {
		if (param.role !== "user" && param.role !== "assistant") continue;
		const isLast = paramIndex === converted.messages.length - 1;
		const named = withSdkToolNames(param.content, options.customToolNameToSdk);
		const content = isLast && options.cacheTtl !== undefined ? withTailBreakpoint(named, options.cacheTtl) : named;
		const source = converted.assistantSources.get(paramIndex) as TaggedAssistantMessage | undefined;
		if (source !== undefined) timestampMs = source.timestamp;
		const uuid = deterministicUuid(options.sessionId, parentUuid ?? "", JSON.stringify(content));
		const message: SeedTranscriptEntry["message"] =
			param.role === "assistant"
				? {
						id: `msg_seed_${uuid.replaceAll("-", "").slice(0, 24)}`,
						type: "message",
						role: "assistant",
						model: source?.model ?? options.model.id,
						content: typeof content === "string" ? [{ type: "text", text: content }] : content,
						stop_reason: hasToolUse(content) ? "tool_use" : "end_turn",
						stop_sequence: null,
						usage: { input_tokens: 0, output_tokens: 0 },
					}
				: { role: "user", content };
		entries.push({
			parentUuid,
			isSidechain: false,
			type: param.role,
			message,
			uuid,
			timestamp: new Date(timestampMs).toISOString(),
			userType: "external",
			entrypoint: "sdk-ts",
			cwd: options.cwd,
			sessionId: options.sessionId,
			version,
			...(param.role === "user" && lastAssistantUuid !== undefined && hasToolResult(content)
				? { sourceToolAssistantUUID: lastAssistantUuid }
				: {}),
		});
		if (param.role === "assistant") {
			lastAssistantUuid = uuid;
			const sourceCount = source?.[SOURCE_COUNT];
			if (sourceCount !== undefined) assistantUuidByIndex.set(sourceCount, uuid);
		}
		parentUuid = uuid;
	}

	return {
		entries,
		assistantUuidByIndex,
		payloadBytes: Buffer.byteLength(JSON.stringify(entries.map((entry) => entry.message)), "utf8"),
	};
}

function javaStringHash(value: string): number {
	let hash = 0;
	for (let index = 0; index < value.length; index++) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
	return hash;
}

/**
 * The directory name Claude Code keeps a working directory's sessions under: the real path with every
 * non-alphanumeric character replaced by `-`, and past 200 characters the first 200 plus a base-36 hash of the path.
 * It must match the CLI's rule exactly; the seed-transcript test reads the result back through the SDK.
 */
export function claudeProjectDirName(cwd: string): string {
	let path = resolve(cwd);
	try {
		path = realpathSync(path);
	} catch {
		// A directory that does not exist yet keeps its resolved path, as the CLI does.
	}
	if (process.platform === "darwin") path = path.normalize("NFC");
	const sanitized = path.replace(/[^a-zA-Z0-9]/g, "-");
	if (sanitized.length <= MAX_PROJECT_DIR_NAME_LENGTH) return sanitized;
	return `${sanitized.slice(0, MAX_PROJECT_DIR_NAME_LENGTH)}-${Math.abs(javaStringHash(path)).toString(36)}`;
}

/** Claude Code's config root: the lane's `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function claudeConfigRoot(configDir: string | undefined): string {
	return (configDir ?? join(homedir(), ".claude")).normalize("NFC");
}

export function claudeTranscriptPath(configDir: string | undefined, cwd: string, sessionId: string): string {
	return join(claudeConfigRoot(configDir), "projects", claudeProjectDirName(cwd), `${sessionId}.jsonl`);
}

/**
 * Write a seed transcript where `resume` and `getSessionMessages` look for it. The file appears whole (temporary file,
 * then rename) and is readable by its owner only. Returns the transcript path.
 */
export function writeSeedTranscript(
	configDir: string | undefined,
	cwd: string,
	entries: readonly SeedTranscriptEntry[],
): string {
	const sessionId = entries[0]?.sessionId;
	if (sessionId === undefined) throw new Error("A seed transcript needs at least one entry.");
	const path = claudeTranscriptPath(configDir, cwd, sessionId);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temporaryPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		renameSync(temporaryPath, path);
	} catch (error) {
		rmSync(temporaryPath, { force: true });
		throw error;
	}
	return path;
}
