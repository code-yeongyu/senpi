import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessageEvent, ImageContent, Model, StopReason, TextContent } from "@earendil-works/pi-ai";

// The hand's parse of the transcript data a forwarded event carries (senpi#5898): each message by its role, each
// content part by its type, the stream events of a reply, and the models a loop sends. A value is accepted whole or
// refused: an unknown role or part type, or a required field of the wrong type, refuses it.

type Check = (value: unknown) => boolean;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const isString: Check = (value) => typeof value === "string";
const isNumber: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isBoolean: Check = (value) => typeof value === "boolean";
const optional =
	(check: Check): Check =>
	(value) =>
		value === undefined || check(value);
const arrayOf =
	(check: Check): Check =>
	(value) =>
		Array.isArray(value) && value.every(check);
const oneOf =
	(...allowed: readonly unknown[]): Check =>
	(value) =>
		allowed.includes(value);

/** `value` is a record whose every listed field passes its check. */
const fields = (value: unknown, checks: Readonly<Record<string, Check>>): value is Record<string, unknown> =>
	isRecord(value) && Object.entries(checks).every(([key, check]) => check(value[key]));

const isText = (value: unknown): value is TextContent =>
	fields(value, { type: oneOf("text"), text: isString, audience: optional(oneOf("model")) });
export const isImage = (value: unknown): value is ImageContent =>
	fields(value, { type: oneOf("image"), data: isString, mimeType: isString });
const isTextOrImage: Check = (value) => isText(value) || isImage(value);
const isUserContent: Check = (value) => isString(value) || arrayOf(isTextOrImage)(value);

const ASSISTANT_PARTS: Readonly<Record<string, Readonly<Record<string, Check>>>> = {
	text: { text: isString },
	thinking: { thinking: isString, redacted: optional(isBoolean) },
	toolCall: { id: isString, name: isString, arguments: isRecord, incomplete: optional(oneOf(true)) },
	providerNative: { subtype: isString },
};
const isAssistantPart: Check = (value) => {
	const checks = isRecord(value) && typeof value.type === "string" ? ASSISTANT_PARTS[value.type] : undefined;
	return checks !== undefined && fields(value, checks);
};

const COST = { input: isNumber, output: isNumber, cacheRead: isNumber, cacheWrite: isNumber, total: isNumber };
const isUsage: Check = (value) =>
	fields(value, {
		input: isNumber,
		output: isNumber,
		cacheRead: isNumber,
		cacheWrite: isNumber,
		totalTokens: isNumber,
		cost: (cost) => fields(cost, COST),
	});
const STOP_REASONS = [
	"pending",
	"stop",
	"length",
	"toolUse",
	"error",
	"aborted",
	"deferred",
] as const satisfies readonly StopReason[];
const timestamped = (checks: Readonly<Record<string, Check>>) => ({ ...checks, timestamp: isNumber });

/** Each message role a session's transcript holds, with the fields that role requires. */
const MESSAGE_ROLES: Readonly<Record<string, Readonly<Record<string, Check>>>> = {
	user: timestamped({ content: isUserContent }),
	assistant: timestamped({
		content: arrayOf(isAssistantPart),
		api: isString,
		provider: isString,
		model: isString,
		usage: isUsage,
		stopReason: oneOf(...STOP_REASONS),
	}),
	toolResult: timestamped({
		toolCallId: isString,
		toolName: isString,
		content: arrayOf(isTextOrImage),
		isError: isBoolean,
	}),
	system: { content: (value) => isString(value) || arrayOf(isText)(value) },
	configurationUpdate: timestamped({ content: arrayOf(isTextOrImage), effort: isString }),
	bashExecution: timestamped({
		command: isString,
		output: isString,
		exitCode: optional(isNumber),
		cancelled: isBoolean,
		truncated: isBoolean,
	}),
	custom: timestamped({ customType: isString, content: isUserContent, display: isBoolean }),
	branchSummary: timestamped({ summary: isString, fromId: (value) => value === null || isString(value) }),
	compactionSummary: timestamped({ summary: isString, tokensBefore: isNumber }),
};

export const isAgentMessage = (value: unknown): value is AgentMessage => {
	const checks = isRecord(value) && typeof value.role === "string" ? MESSAGE_ROLES[value.role] : undefined;
	return checks !== undefined && fields(value, checks);
};

export const isAgentMessages = (value: unknown): value is AgentMessage[] =>
	Array.isArray(value) && value.every(isAgentMessage);

const isAssistantMessage: Check = (value) => isRecord(value) && value.role === "assistant" && isAgentMessage(value);
const PARTIAL = { partial: isAssistantMessage };
const INDEXED = { contentIndex: isNumber, partial: isAssistantMessage };

/** Each stream event of an assistant reply, with the fields its type carries. */
const STREAM_EVENTS: Readonly<Record<string, Readonly<Record<string, Check>>>> = {
	start: PARTIAL,
	text_start: INDEXED,
	text_delta: { ...INDEXED, delta: isString },
	text_end: { ...INDEXED, content: isString },
	thinking_start: INDEXED,
	thinking_delta: { ...INDEXED, delta: isString },
	thinking_end: { ...INDEXED, content: isString },
	toolcall_start: INDEXED,
	toolcall_delta: { ...INDEXED, delta: isString },
	toolcall_end: { ...INDEXED, toolCall: (value) => isRecord(value) && isAssistantPart(value) },
	done: { reason: oneOf("stop", "length", "toolUse", "deferred"), message: isAssistantMessage },
	error: { reason: oneOf("aborted", "error"), error: isAssistantMessage },
};

export const isAssistantMessageEvent = (value: unknown): value is AssistantMessageEvent => {
	const checks = isRecord(value) && typeof value.type === "string" ? STREAM_EVENTS[value.type] : undefined;
	return checks !== undefined && fields(value, checks);
};

/**
 * A model as the loop sends it. It never carries `headers`: a model's own headers can carry a credential and never
 * leave the side that dials (CK21, `hand/hook-contract.ts`), so a model with them is refused.
 */
export const isModel = (value: unknown): value is Model<Api> =>
	isRecord(value) &&
	!("headers" in value) &&
	fields(value, {
		id: isString,
		name: isString,
		api: isString,
		provider: isString,
		baseUrl: isString,
		reasoning: isBoolean,
		input: arrayOf(oneOf("text", "image", "video")),
		cost: (cost) => fields(cost, { input: isNumber, output: isNumber, cacheRead: isNumber, cacheWrite: isNumber }),
		contextWindow: isNumber,
		maxTokens: isNumber,
	});
