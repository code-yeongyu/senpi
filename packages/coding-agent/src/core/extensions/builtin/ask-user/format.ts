import {
	type AskUserVariant,
	DEFAULT_ASK_USER_TIMEOUT_MS,
	type QuestionRequest,
	type QuestionResponse,
} from "./schema.ts";

export type CodexResultDetails = {
	answers: Record<string, { answers: string[] }>;
	comment?: string;
	unanswered: string[];
	status: QuestionResponse["status"];
};

export type ClaudeResultDetails = {
	questions: QuestionRequest["questions"];
	answers: Record<string, string>;
	freeText?: string;
	unanswered: string[];
	status: QuestionResponse["status"];
};

type Questions = QuestionRequest["questions"];

function headerFor(id: string, questions: Questions): string {
	return questions.find((question) => question.id === id)?.header ?? id;
}

function questionTextFor(id: string, questions: Questions): string {
	return questions.find((question) => question.id === id)?.question ?? id;
}

function answerBody(answer: { selected: string[]; text?: string } | undefined): string | undefined {
	if (!answer) return undefined;
	if (answer.selected.length > 0) return answer.selected.join(", ");
	const text = answer.text?.trim();
	return text === undefined || text.length === 0 ? undefined : text;
}

function answeredLines(response: QuestionResponse, questions: Questions): string[] {
	const lines: string[] = [];
	const seen = new Set<string>();
	for (const question of questions) {
		const body = answerBody(response.answers[question.id]);
		if (body !== undefined) {
			lines.push(`${question.header}: ${body}`);
			seen.add(question.id);
		}
	}
	for (const [id, answer] of Object.entries(response.answers)) {
		if (seen.has(id)) continue;
		const body = answerBody(answer);
		if (body !== undefined) lines.push(`${headerFor(id, questions)}: ${body}`);
	}
	return lines;
}

function formatBody(response: QuestionResponse, questions: Questions): string {
	switch (response.status) {
		case "answered": {
			const lines = answeredLines(response, questions);
			const unanswered = response.unanswered.map((id) => headerFor(id, questions));
			if (unanswered.length > 0) lines.push(`Unanswered: ${unanswered.join(", ")}`);
			return lines.join("\n");
		}
		case "comment-submitted": {
			const lines = [`The user responded: ${response.comment?.trim() ?? ""}`, ...answeredLines(response, questions)];
			const unanswered = response.unanswered.map((id) => headerFor(id, questions));
			if (unanswered.length > 0) lines.push(`Unanswered: ${unanswered.join(", ")}`);
			return lines.join("\n");
		}
		case "timed_out": {
			const minutes = Math.round((response.autoResolvedAfterMs ?? DEFAULT_ASK_USER_TIMEOUT_MS) / 60_000);
			const lines = [
				`The user did not answer within ${minutes} minutes. (사용자가 답변을 안하고 timeout 으로 종료됨)`,
			];
			const selected = answeredLines(response, questions);
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

export function formatResultText(
	_variant: AskUserVariant,
	response: QuestionResponse,
	questions: Questions = [],
): string {
	return formatBody(response, questions);
}

export function formatUserMessage(response: QuestionResponse, requestId: string, questions: Questions = []): string {
	return `[Answer to question ${requestId}]\n${formatBody(response, questions)}`;
}

function selectedAnswers(answer: { selected: string[]; text?: string }): string[] {
	if (answer.selected.length > 0) return answer.selected;
	const text = answer.text?.trim();
	return text === undefined || text.length === 0 ? [] : [text];
}

export function formatResultDetails(
	variant: AskUserVariant,
	response: QuestionResponse,
	questions: Questions = [],
): CodexResultDetails | ClaudeResultDetails {
	if (variant === "codex") {
		const answers: CodexResultDetails["answers"] = {};
		for (const [id, answer] of Object.entries(response.answers)) {
			answers[id] = { answers: selectedAnswers(answer) };
		}
		const details: CodexResultDetails = {
			answers,
			unanswered: response.unanswered,
			status: response.status,
		};
		if (response.comment !== undefined) details.comment = response.comment;
		return details;
	}
	const answers: Record<string, string> = {};
	for (const [id, answer] of Object.entries(response.answers)) {
		const body = answerBody(answer);
		if (body !== undefined) answers[questionTextFor(id, questions)] = body;
	}
	const details: ClaudeResultDetails = {
		questions,
		answers,
		unanswered: response.unanswered.map((id) => questionTextFor(id, questions)),
		status: response.status,
	};
	if (response.comment !== undefined) details.freeText = response.comment;
	return details;
}
