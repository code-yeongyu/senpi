import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { type ToolResultUserWord, userWordBlocks } from "../../../tool-result-user-words.ts";
import {
	type AskUserVariant,
	DEFAULT_ASK_USER_TIMEOUT_MS,
	type QuestionRequest,
	type QuestionResponse,
} from "./schema.ts";
import {
	INLINE_WORDS,
	readUserWordBlocks,
	resolveUserWordReferences,
	separatedWords,
	type WordPlacement,
} from "./user-words.ts";

export type CodexResultDetails = {
	resolvedBy?: QuestionResponse["resolvedBy"];
	answers: Record<string, { answers: string[] }>;
	comment?: string;
	unanswered: string[];
	status: QuestionResponse["status"];
	userWords?: ToolResultUserWord[];
};

export type ClaudeResultDetails = {
	resolvedBy?: QuestionResponse["resolvedBy"];
	questions: QuestionRequest["questions"];
	answers: Record<string, string>;
	freeText?: string;
	unanswered: string[];
	status: QuestionResponse["status"];
	userWords?: ToolResultUserWord[];
};

type Questions = QuestionRequest["questions"];
type Question = Questions[number];

function headerFor(id: string, questions: Questions): string {
	return questions.find((question) => question.id === id)?.header ?? id;
}

function questionTextFor(id: string, questions: Questions): string {
	return questions.find((question) => question.id === id)?.question ?? id;
}

function typedText(answer: { selected: string[]; text?: string }): string | undefined {
	if (answer.selected.length > 0) return undefined;
	const text = answer.text?.trim();
	return text === undefined || text.length === 0 ? undefined : text;
}

/** A typed text that repeats an offered label (clients that report picks as text) is not the user's own words. */
function answerBody(
	answer: { selected: string[]; text?: string } | undefined,
	header: string,
	words: WordPlacement = INLINE_WORDS,
	offered: Question["options"] = [],
): string | undefined {
	if (!answer) return undefined;
	if (answer.selected.length > 0) return answer.selected.join(", ");
	const text = typedText(answer);
	if (text === undefined) return undefined;
	return offered.some((option) => option.label === text) ? text : words.typed(header, text);
}

function answeredLines(response: QuestionResponse, questions: Questions, words: WordPlacement): string[] {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const question of questions) {
		const body = answerBody(response.answers[question.id], question.header, words, question.options);
		if (body !== undefined) {
			lines.push(`${question.header}: ${body}`);
			seen.add(question.id);
		}
	}
	for (const [id, answer] of Object.entries(response.answers)) {
		if (seen.has(id)) continue;
		const header = headerFor(id, questions);
		const body = answerBody(answer, header, words);
		if (body !== undefined) lines.push(`${header}: ${body}`);
	}
	return lines;
}

const GATED_NO_ANSWER = "No answer: do not take the action it gates. Keep that action pending and end the turn.";

/** A required question gates an action, so every settlement without an answer refuses that action (senpi#2949). */
function formatGatedNoAnswer(
	response: QuestionResponse,
	questions: Questions,
	words: WordPlacement,
	cancellationReason?: string,
): string {
	const reason =
		cancellationReason ??
		(response.status === "timed_out"
			? `The user did not answer within ${Math.round((response.autoResolvedAfterMs ?? DEFAULT_ASK_USER_TIMEOUT_MS) / 60_000)} minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)`
			: response.status === "cancelled"
				? "The user dismissed the question."
				: response.status === "orphaned-after-restart"
					? "The pending question could not be resumed after a restart."
					: "This session has no user attached (subagent or headless).");
	const lines = [reason];
	const selected = answeredLines(response, questions, words);
	if (selected.length > 0)
		lines.push(`Before going idle the user had selected (not an answer): ${selected.join("; ")}`);
	lines.push(GATED_NO_ANSWER);
	return lines.join("\n");
}

/**
 * A required question cancelled with a reason (a UI failure): the reason stands in for the status line,
 * a draft the user typed is named and marked not an answer, and the action is refused (senpi#2949).
 */
export function formatGatedCancellation(
	reason: string,
	response: QuestionResponse,
	requestId: string,
	questions: Questions,
): string {
	return formatGatedNoAnswer(response, questions, separatedWords(requestId), reason);
}

function formatBody(response: QuestionResponse, questions: Questions, words: WordPlacement, required = false): string {
	if (required && response.status !== "answered" && response.status !== "comment-submitted") {
		return formatGatedNoAnswer(response, questions, words);
	}
	switch (response.status) {
		case "answered": {
			const lines = answeredLines(response, questions, words);
			const unanswered = response.unanswered.map((id) => headerFor(id, questions));
			if (unanswered.length > 0) lines.push(`Unanswered: ${unanswered.join(", ")}`);
			return lines.join("\n");
		}
		case "comment-submitted": {
			const comment = response.comment?.trim() ?? "";
			const lines = [
				`The user responded: ${comment.length > 0 ? words.comment(comment) : ""}`,
				...answeredLines(response, questions, words),
			];
			const unanswered = response.unanswered.map((id) => headerFor(id, questions));
			if (unanswered.length > 0) lines.push(`Unanswered: ${unanswered.join(", ")}`);
			return lines.join("\n");
		}
		case "timed_out": {
			const minutes = Math.round((response.autoResolvedAfterMs ?? DEFAULT_ASK_USER_TIMEOUT_MS) / 60_000);
			const lines = [
				`The user did not answer within ${minutes} minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)`,
			];
			const selected = answeredLines(response, questions, words);
			if (selected.length > 0) {
				lines.push(`Before going idle the user had selected: ${selected.join("; ")}`);
			}
			lines.push("Continue the work to completion on your best judgment; do not ask this question again this turn.");
			return lines.join("\n");
		}
		case "cancelled":
			return "The user dismissed the question.";
		case "orphaned-after-restart":
			return "The pending question could not be resumed after a restart; continue on best judgment.";
		case "unavailable":
			return "This session has no user attached (subagent or headless); decide on best judgment.";
	}
}

/** The answer as a person reads it, with the user's words inline (hooks, the transcript card). */
export function formatResultText(
	_variant: AskUserVariant,
	response: QuestionResponse,
	questions: Questions = [],
	required = false,
): string {
	return formatBody(response, questions, INLINE_WORDS, required);
}

/**
 * The answer as the model receives it: `text` holds only the structure and the options the model
 * offered; each of the user's own words is a `words` entry that `text` names by its label.
 */
export function formatModelAnswer(
	response: QuestionResponse,
	requestId: string,
	questions: Questions = [],
	required = false,
): { text: string; words: ToolResultUserWord[] } {
	const placement = separatedWords(requestId);
	return { text: formatBody(response, questions, placement, required), words: placement.words };
}

/**
 * The framed user message for a later answer: the `[Answer to question <id>]` frame with the
 * structure, then each of the user's words after its own label block. An answer with no typed
 * words stays the single framed string it always was.
 */
export function formatUserMessage(
	response: QuestionResponse,
	requestId: string,
	questions: Questions = [],
	required = false,
): string | TextContent[] {
	const answer = formatModelAnswer(response, requestId, questions, required);
	const frame = `[Answer to question ${requestId}]\n${answer.text}`;
	if (answer.words.length === 0) return frame;
	return [{ type: "text", text: frame }, ...userWordBlocks(answer.words)];
}

/** Display text of a framed answer whose words travel as labelled blocks; undefined otherwise. */
export function askUserAnswerDisplayText(content: string | (TextContent | ImageContent)[]): string | undefined {
	if (typeof content === "string") return undefined;
	const [first, ...rest] = content;
	if (first?.type !== "text" || rest.length === 0 || !parseAskUserAnswerFrame(first.text)) return undefined;
	const words = readUserWordBlocks(rest);
	return words ? resolveUserWordReferences(first.text, words) : undefined;
}

export interface AskUserAnswerFrame {
	readonly requestId: string;
	readonly body: string;
}

export function parseAskUserAnswerFrame(text: string): AskUserAnswerFrame | undefined {
	const match = /^\[Answer to question ([^\]\r\n]+)\]\r?\n([\s\S]*)$/.exec(text);
	return match ? { requestId: match[1], body: match[2] } : undefined;
}

function selectedAnswers(answer: { selected: string[]; text?: string }): string[] {
	if (answer.selected.length > 0) return answer.selected;
	const text = answer.text?.trim();
	return text === undefined || text.length === 0 ? [] : [text];
}

export function formatResultDetails(
	variant: AskUserVariant,
	response: QuestionResponse,
	requestId: string,
	questions: Questions = [],
	required = false,
): CodexResultDetails | ClaudeResultDetails {
	const { words } = formatModelAnswer(response, requestId, questions, required);
	if (variant === "codex") {
		const answers: CodexResultDetails["answers"] = {};
		for (const [id, answer] of Object.entries(response.answers)) {
			answers[id] = { answers: selectedAnswers(answer) };
		}
		const details: CodexResultDetails = {
			...(response.resolvedBy !== undefined ? { resolvedBy: response.resolvedBy } : {}),
			answers,
			unanswered: response.unanswered,
			status: response.status,
		};
		if (response.comment !== undefined) details.comment = response.comment;
		if (words.length > 0) details.userWords = words;
		return details;
	}
	const answers: Record<string, string> = {};
	for (const [id, answer] of Object.entries(response.answers)) {
		const body = answerBody(answer, headerFor(id, questions));
		if (body !== undefined) answers[questionTextFor(id, questions)] = body;
	}
	const details: ClaudeResultDetails = {
		...(response.resolvedBy !== undefined ? { resolvedBy: response.resolvedBy } : {}),
		questions,
		answers,
		unanswered: response.unanswered.map((id) => questionTextFor(id, questions)),
		status: response.status,
	};
	if (response.comment !== undefined) details.freeText = response.comment;
	if (words.length > 0) details.userWords = words;
	return details;
}
