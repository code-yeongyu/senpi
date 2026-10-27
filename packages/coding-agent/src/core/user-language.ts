import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type ReplyLanguageReading, readReplyLanguage, SCRIPT_LANGUAGE_NAMES } from "./reply-language-reading.ts";
import { REQUESTABLE_LANGUAGE_NAMES, readReplyLanguageRequest } from "./reply-language-request.ts";
import { followerMessage, toolResultUserWords } from "./tool-result-user-words.ts";

/**
 * The user's reply language, carried through long English stretches of context (omo#11527).
 *
 * A long session puts a lot of English between the user's last message and the next reply: tool
 * results, skill bodies, harness notices, and after a compaction an English summary in place of the
 * user's own turns. The model then answers in the language of the most recent context. Each request
 * therefore carries a short note naming the reply language after such a stretch: the language the
 * user explicitly asked for, else the non-Latin language they write in. The note is derived only
 * from the messages themselves, at fixed positions, so every request extends the previous one
 * unchanged and the provider's cache prefix stays valid.
 */

/** Harness text (tool output, notices, summaries) since the user's last message that earns a note. */
export const REPLY_LANGUAGE_NOTE_MIN_CHARS = 4000;

/** The reply language and whether the user explicitly asked for it. */
export interface ReplyLanguage {
	readonly language: string;
	readonly requested: boolean;
}

/** Every language name a note can carry; a note never carries any other text. */
const REPLY_LANGUAGE_NAMES = [...new Set([...SCRIPT_LANGUAGE_NAMES, ...REQUESTABLE_LANGUAGE_NAMES])];

const WRITTEN = "the language of the user's messages";
const REQUESTED = "the user asked for it";

export function replyLanguageNote({ language, requested }: ReplyLanguage): string {
	return `Reply language: ${language} (${requested ? REQUESTED : WRITTEN}). The text since the user's last message is tool output, files, notices or a summary; keep writing to the user in ${language}.`;
}

const NOTED_LANGUAGE = new RegExp(
	`Reply language: (${REPLY_LANGUAGE_NAMES.join("|")}) \\((${WRITTEN}|${REQUESTED})\\)`,
);

interface ReplyLanguageState {
	readonly requested?: string;
	readonly written?: string;
}

interface UserMessageReading {
	readonly noted?: ReplyLanguage;
	readonly request?: string;
	readonly reading: ReplyLanguageReading;
}

/** Session files are parsed without validation, so content may be missing or malformed. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block: unknown) =>
			typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
				? block.text
				: "",
		)
		.join("\n");
}

/**
 * The shape of a message's content: its block count and text lengths. No caller edits user content
 * in place today (context edits and the environment fold build new messages), but a context hook
 * could; an edit that changes the shape then invalidates the cached reading. Computing it touches
 * each block once, never the text.
 */
function contentShape(content: unknown): string {
	if (typeof content === "string") return `s${content.length}`;
	if (!Array.isArray(content)) return "-";
	return content
		.map((block: unknown) =>
			typeof block === "object" && block !== null && "text" in block && typeof block.text === "string"
				? block.text.length
				: "x",
		)
		.join(",");
}

/**
 * Each conversion re-reads the whole history, so a message's reading is kept with the message and
 * recomputed only when its content object or the content's shape changes.
 */
const readings = new WeakMap<
	object,
	{ readonly content: unknown; readonly shape: string; readonly reading: UserMessageReading }
>();

function readUserMessage(message: { readonly content: unknown }): UserMessageReading {
	const shape = contentShape(message.content);
	const cached = readings.get(message);
	if (cached && cached.content === message.content && cached.shape === shape) return cached.reading;
	const text = textOf(message.content);
	const noted = NOTED_LANGUAGE.exec(text);
	const reading: UserMessageReading = noted
		? { noted: { language: noted[1] ?? "", requested: noted[2] === REQUESTED }, reading: { kind: "none" } }
		: { request: readReplyLanguageRequest(text), reading: readReplyLanguage(text) };
	readings.set(message, { content: message.content, shape, reading });
	return reading;
}

function advance(state: ReplyLanguageState, message: { readonly content: unknown }): ReplyLanguageState {
	const { noted, request, reading } = readUserMessage(message);
	if (noted) return noted.requested ? { ...state, requested: noted.language } : { written: noted.language };
	const written = reading.kind === "none" ? state.written : reading.kind === "language" ? reading.language : undefined;
	return { requested: request ?? state.requested, written };
}

function current(state: ReplyLanguageState): ReplyLanguage | undefined {
	if (state.requested !== undefined) return { language: state.requested, requested: true };
	if (state.written !== undefined) return { language: state.written, requested: false };
	return undefined;
}

/** The reply language the user's messages establish, oldest to newest (a compaction's summary). */
export function replyLanguageOf(messages: readonly AgentMessage[]): ReplyLanguage | undefined {
	let state: ReplyLanguageState = {};
	for (const message of messages) if (message.role === "user") state = advance(state, message);
	return current(state);
}

function harnessTextLength(message: AgentMessage): number {
	switch (message.role) {
		case "toolResult":
		case "custom":
			return textOf(message.content).length;
		case "bashExecution":
			return message.excludeFromContext ? 0 : textOf(message.command).length + textOf(message.output).length;
		case "branchSummary":
			return textOf(message.summary).length;
		default:
			return 0;
	}
}

/**
 * Inserts a reply-language note after a tool-result run that the next assistant message (or the
 * end) follows, once harness text since the user's last message reaches the threshold. The user's
 * own message resets the count. A run that carries words the user typed into a tool's answer gets
 * no note: those words already follow the run as a user message (senpi#2920), and a second user
 * message right after them would break strict alternation (senpi#2118). A compaction summary names
 * the language in its own text block instead (convertToLlm).
 */
export function insertReplyLanguageNotes(messages: AgentMessage[]): AgentMessage[] {
	let state: ReplyLanguageState = {};
	let pending = 0;
	let runHasUserWords = false;
	let result: AgentMessage[] | undefined;
	for (const [index, message] of messages.entries()) {
		result?.push(message);
		if (message.role !== "toolResult") runHasUserWords = false;
		if (message.role === "user") {
			state = advance(state, message);
			pending = 0;
			continue;
		}
		if (message.role === "compactionSummary") {
			const language = message.userLanguage;
			state =
				language === undefined
					? {}
					: message.userLanguageRequested
						? { requested: language }
						: { written: language };
			pending = 0;
			continue;
		}
		if (message.role === "toolResult" && toolResultUserWords(message).length > 0) {
			runHasUserWords = true;
			pending = 0;
			continue;
		}
		pending += harnessTextLength(message);
		const language = current(state);
		const next = messages[index + 1];
		if (message.role !== "toolResult" || runHasUserWords || !language) continue;
		if (pending < REPLY_LANGUAGE_NOTE_MIN_CHARS || (next !== undefined && next.role !== "assistant")) continue;
		result ??= messages.slice(0, index + 1);
		// The note belongs to the results it follows, like the words a user types into a tool's answer.
		result.push(followerMessage([{ type: "text", text: replyLanguageNote(language) }], message));
		pending = 0;
	}
	return result ?? messages;
}
