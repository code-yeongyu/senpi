import { createHash } from "node:crypto";
import type { Context, ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import type { ClaudeSdkOauthAuthLane } from "./options.ts";
import type { Base64ImageSource, ContentBlockParam, Options } from "./sdk-boundary.ts";
import type { ClaudeSdkOauthSessionEntry } from "./session-registry.ts";
import { HOST_TOOL_POLICY_FINGERPRINT, mapPiToolNameToSdk } from "./tools.ts";

export type SentMessage = Extract<Message, { role: "user" | "toolResult" }>;

export type SessionConfigFingerprint = {
	systemPromptHash: string;
	toolsetHash: string;
};

const sentHashesByEntry = new WeakMap<ClaudeSdkOauthSessionEntry, string[]>();

function stableValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "function") return `[function:${value.name}:${value.toString()}]`;
	if (typeof value === "bigint") return value.toString();
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	const normalized = Array.isArray(value)
		? value.map((item) => stableValue(item, seen))
		: Object.fromEntries(
				Object.entries(value as Record<string, unknown>)
					.filter(([, item]) => item !== undefined)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, item]) => [key, stableValue(item, seen)]),
			);
	seen.delete(value);
	return normalized;
}

function digest(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(stableValue(value)))
		.digest("hex");
}

export function sessionSyncDigest(value: unknown): string {
	return digest(value);
}

export function sentMessages(context: Context): SentMessage[] {
	const messages = context.messages.filter(
		(message): message is SentMessage => message.role === "user" || message.role === "toolResult",
	);
	return messages;
}

export function sentMessageHashes(messages: readonly SentMessage[]): string[] {
	const hashes = messages.map((message) =>
		digest(
			message.role === "user"
				? { role: message.role, content: message.content }
				: {
						role: message.role,
						toolCallId: message.toolCallId,
						toolName: message.toolName,
						content: message.content,
					},
		),
	);
	return hashes;
}

function prefixDigest(hashes: readonly string[], count = hashes.length): string {
	return digest(hashes.slice(0, count));
}

/** Pure divergence guard: every non-proven continuation resolves to cold-seed. */

export function sentHashesForEntry(entry: ClaudeSdkOauthSessionEntry): readonly string[] | undefined {
	return sentHashesByEntry.get(entry);
}

export function recordSyncedStream(entry: ClaudeSdkOauthSessionEntry, hashes: readonly string[]): void {
	const copy = [...hashes];
	sentHashesByEntry.set(entry, copy);
	entry.sentCount = copy.length;
	entry.syncedPrefixHash = prefixDigest(copy);
	entry.branchInfo = null;
}

const GENERATED_DATE_LINE = /\nCurrent date: \d{4}-\d{2}-\d{2}(?=\nCurrent working directory: [^\n]*$)/;

/**
 * The generated date line advances at UTC midnight while the conversation is
 * unchanged; hashing it verbatim retires a live session at midnight for no
 * semantic reason. Only that exact terminal line is neutralized - cwd and every
 * other prompt region stay fail-closed.
 */
function fingerprintSystemPrompt(systemPrompt: Options["systemPrompt"]): unknown {
	if (typeof systemPrompt !== "string") return systemPrompt ?? null;
	return systemPrompt.replace(GENERATED_DATE_LINE, "\nCurrent date: <session-date>");
}

export function configFingerprint(
	options: Options,
	context: Context,
	authLane: ClaudeSdkOauthAuthLane,
	accountName: string,
): SessionConfigFingerprint {
	return {
		systemPromptHash: digest(fingerprintSystemPrompt(options.systemPrompt)),
		toolsetHash: digest({
			tools: options.tools ?? [],
			reasoning: {
				thinking: options.thinking,
				effort: options.effort,
				maxThinkingTokens: options.maxThinkingTokens,
			},
			contextTools: (context.tools ?? []).map((tool) => ({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			})),
			cwd: options.cwd,
			authLane,
			accountName,
			permissionMode: options.permissionMode,
			hostToolPolicy: HOST_TOOL_POLICY_FINGERPRINT,
			settingSources: options.settingSources,
			extraArgs: options.extraArgs,
			pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
			includePartialMessages: options.includePartialMessages,
		}),
	};
}

function appendContent(blocks: ContentBlockParam[], content: string | readonly (TextContent | ImageContent)[]): void {
	if (typeof content === "string") {
		blocks.push({ type: "text", text: content });
		return;
	}
	for (const block of content) {
		blocks.push(
			block.type === "text"
				? { type: "text", text: block.text }
				: {
						type: "image",
						source: {
							type: "base64",
							media_type: block.mimeType as Base64ImageSource["media_type"],
							data: block.data,
						},
					},
		);
	}
}

export function buildDeltaPromptBlocks(
	messages: readonly SentMessage[],
	customToolNameToSdk?: ReadonlyMap<string, string>,
): ContentBlockParam[] {
	const blocks: ContentBlockParam[] = [];
	for (const [index, message] of messages.entries()) {
		if (index > 0) blocks.push({ type: "text", text: "\n\n" });
		if (message.role === "toolResult") {
			blocks.push({
				type: "text",
				text: `Tool result (${mapPiToolNameToSdk(message.toolName, customToolNameToSdk)}, id=${message.toolCallId}):\n`,
			});
		}
		appendContent(blocks, message.content);
	}
	return blocks;
}
