import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { followerMessage, toolResultUserWords } from "./tool-result-user-words.ts";

/**
 * The user's reply language, carried through long English stretches of context (omo#11527).
 *
 * A long session puts a lot of English between the user's last message and the next reply: tool
 * results, skill bodies, harness notices, and after a compaction an English summary in place of the
 * user's own turns. The model then answers in the language of the most recent context. Each request
 * therefore carries a short note naming the language of the user's own messages after such a
 * stretch. The note is derived only from the messages themselves, at fixed positions, so every
 * request extends the previous one unchanged and the provider's cache prefix stays valid.
 */

/** Harness text (tool output, notices, summaries) since the user's last message that earns a note. */
export const REPLY_LANGUAGE_NOTE_MIN_CHARS = 4000;

export function replyLanguageNote(language: string): string {
	return `Reply language: the language of the user's messages (${language}). The text since the user's last message is tool output, files, notices or a summary; keep writing to the user in ${language}.`;
}

const NOTED_LANGUAGE = /Reply language: the language of the user's messages \(([^)\n]+)\)/;

/** The language an earlier note named, when this text carries one (converted output converted again). */
function notedLanguage(text: string): string | undefined {
	return NOTED_LANGUAGE.exec(text)?.[1];
}

type ScriptName = "hangul" | "kana" | "han" | "thai" | "greek" | "hebrew" | "cyrillic" | "arabic" | "devanagari";

const SCRIPTS: readonly { readonly name: ScriptName; readonly pattern: RegExp; readonly spaced: boolean }[] = [
	{ name: "hangul", pattern: /\p{Script=Hangul}/gu, spaced: true },
	{ name: "kana", pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu, spaced: false },
	{ name: "han", pattern: /\p{Script=Han}/gu, spaced: false },
	{ name: "thai", pattern: /\p{Script=Thai}/gu, spaced: false },
	{ name: "greek", pattern: /\p{Script=Greek}/gu, spaced: true },
	{ name: "hebrew", pattern: /\p{Script=Hebrew}/gu, spaced: true },
	{ name: "cyrillic", pattern: /\p{Script=Cyrillic}/gu, spaced: true },
	{ name: "arabic", pattern: /\p{Script=Arabic}/gu, spaced: true },
	{ name: "devanagari", pattern: /\p{Script=Devanagari}/gu, spaced: true },
];

/** A script shared by several languages is named by its script, never by a guessed language. */
const LANGUAGE_OF_SCRIPT: Record<Exclude<ScriptName, "han">, string> = {
	hangul: "Korean",
	kana: "Japanese",
	thai: "Thai",
	greek: "Greek",
	hebrew: "Hebrew",
	cyrillic: "Cyrillic script",
	arabic: "Arabic script",
	devanagari: "Devanagari script",
};

/** A script that is at least this share of the words decides the language. */
const SCRIPT_SHARE = 0.3;

/** Characters per word for scripts written without spaces (Chinese, Japanese, Thai). */
const UNSPACED_CHARS_PER_WORD = 2;

/**
 * What one user message says about the reply language: `none` when it has no words (an image, or
 * only injected blocks), `latin` when Latin-script words dominate (a language this note cannot name
 * safely, and English needs no note), or the named non-Latin language.
 */
export type ReplyLanguageReading = { kind: "none" } | { kind: "latin" } | { kind: "language"; language: string };

/** Fenced or inline code, links and tagged blocks (`<environment_context>`, reminders) are not the user's prose. */
function userProse(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		.replace(/<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g, " ")
		.replace(/\bhttps?:\/\/\S+/g, " ");
}

export function readReplyLanguage(text: string): ReplyLanguageReading {
	const weights = new Map<ScriptName, number>();
	let latinWords = 0;
	for (const word of userProse(text).split(/\s+/)) {
		let scripted = false;
		for (const script of SCRIPTS) {
			const count = word.match(script.pattern)?.length ?? 0;
			if (count === 0) continue;
			const weight = script.spaced ? 1 : count / UNSPACED_CHARS_PER_WORD;
			weights.set(script.name, (weights.get(script.name) ?? 0) + weight);
			scripted = true;
			break;
		}
		if (!scripted && /\p{Script=Latin}/u.test(word)) latinWords++;
	}
	// Japanese mixes kana with Han characters; Han without kana is Chinese.
	const kana = weights.get("kana") ?? 0;
	const han = weights.get("han") ?? 0;
	if (kana > 0) {
		weights.set("kana", kana + han);
		weights.delete("han");
	}
	let best: { name: ScriptName; weight: number } | undefined;
	let total = latinWords;
	for (const [name, weight] of weights) {
		total += weight;
		if (!best || weight > best.weight) best = { name, weight };
	}
	if (total === 0) return { kind: "none" };
	if (!best || best.weight < total * SCRIPT_SHARE) return { kind: "latin" };
	return { kind: "language", language: best.name === "han" ? "Chinese" : LANGUAGE_OF_SCRIPT[best.name] };
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

/** A user-role message that carries an earlier note (a summary or the note itself) keeps its language. */
function readUserMessage(content: unknown): ReplyLanguageReading {
	const text = textOf(content);
	const noted = notedLanguage(text);
	return noted === undefined ? readReplyLanguage(text) : { kind: "language", language: noted };
}

/** Reads the user's own messages, newest first, until one has words. */
export function latestReplyLanguage(messages: readonly AgentMessage[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const reading = readUserMessage(message.content);
		if (reading.kind === "none") continue;
		return reading.kind === "language" ? reading.language : undefined;
	}
	return undefined;
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
 * end) follows, once harness text since the user's last message reaches the threshold and the user
 * writes a non-Latin language. A note right after tool results never makes two user messages
 * adjacent. The user's own message (or words they typed into a tool's answer) resets the count. A
 * compaction summary names the language of the turns it replaced in its own text (convertToLlm).
 */
export function insertReplyLanguageNotes(messages: AgentMessage[]): AgentMessage[] {
	let language: string | undefined;
	let pending = 0;
	let result: AgentMessage[] | undefined;
	for (const [index, message] of messages.entries()) {
		result?.push(message);
		if (message.role === "user") {
			const reading = readUserMessage(message.content);
			if (reading.kind !== "none") language = reading.kind === "language" ? reading.language : undefined;
			pending = 0;
			continue;
		}
		if (message.role === "compactionSummary") {
			language = message.userLanguage;
			pending = 0;
			continue;
		}
		if (message.role === "toolResult" && toolResultUserWords(message).length > 0) {
			pending = 0;
			continue;
		}
		const length = harnessTextLength(message);
		if (length === 0) continue;
		pending += length;
		const next = messages[index + 1];
		if (message.role !== "toolResult" || !language || pending < REPLY_LANGUAGE_NOTE_MIN_CHARS) continue;
		if (next !== undefined && next.role !== "assistant") continue;
		result ??= messages.slice(0, index + 1);
		// The note belongs to the results it follows, like the words a user types into a tool's answer.
		result.push(followerMessage([{ type: "text", text: replyLanguageNote(language) }], message));
		pending = 0;
	}
	return result ?? messages;
}
