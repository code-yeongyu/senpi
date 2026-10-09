import type { ExtensionUIContext, QuestionRequest, QuestionResponse } from "../../../core/extensions/types.ts";
import type { RequestId, ToolRequestUserInputParams, ToolRequestUserInputResponse } from "../protocol/index.ts";

export type UserInputParams = Omit<ToolRequestUserInputParams, "questions" | "autoResolutionMs"> & {
	questions: Array<ToolRequestUserInputParams["questions"][number] & { multiSelect: boolean }>;
	autoResolutionMs: null;
	timeoutMs: number;
	waitForAnswer: boolean;
};
export type UserInputResult = ToolRequestUserInputResponse & { comment?: string; cancelled?: boolean };
export type UserInputRequest = { id: RequestId; method: "item/tool/requestUserInput"; params: UserInputParams };
export type UserInputOutboundMessage =
	| UserInputRequest
	| {
			method: "serverRequest/resolved";
			params: { threadId: string; requestId: RequestId };
	  };
export type UserInputOptions = Parameters<NonNullable<ExtensionUIContext["question"]>>[1];
export type UserInputResponse = { id: RequestId; result?: unknown; error?: unknown };
export type UserInputDraft = { answers: QuestionResponse["answers"]; comment?: string };

export class UserInputProtocolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UserInputProtocolError";
	}
}
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function readUserInputResult(value: unknown): UserInputResult {
	if (!isRecord(value)) throw new UserInputProtocolError("Invalid user input result");
	if (value.comment !== undefined && typeof value.comment !== "string") {
		throw new UserInputProtocolError("Invalid user input comment");
	}
	if (value.cancelled !== undefined && typeof value.cancelled !== "boolean") {
		throw new UserInputProtocolError("Invalid user input cancellation");
	}
	const answers: UserInputResult["answers"] = {};
	if (value.answers !== undefined) {
		if (!isRecord(value.answers)) throw new UserInputProtocolError("Invalid user input answers");
		for (const [id, answer] of Object.entries(value.answers)) {
			if (!isRecord(answer) || !Array.isArray(answer.answers)) {
				throw new UserInputProtocolError("Invalid user input answer");
			}
			const strings: string[] = [];
			for (const text of answer.answers) {
				if (typeof text !== "string") throw new UserInputProtocolError("Invalid user input answer text");
				strings.push(text);
			}
			answers[id] = { answers: strings };
		}
	}
	return { answers, comment: value.comment, cancelled: value.cancelled };
}
export function toDraft(request: QuestionRequest, result: UserInputResult): UserInputDraft {
	const answers: QuestionResponse["answers"] = {};
	for (const question of request.questions) {
		const values = result.answers[question.id]?.answers;
		if (!values) continue;
		const labels = new Set(question.options.map((option) => option.label));
		const selected = values.filter((value) => labels.has(value));
		const text = values.filter((value) => !labels.has(value)).join("\n");
		answers[question.id] = { selected, ...(text ? { text } : {}) };
	}
	return { answers, ...(result.comment !== undefined ? { comment: result.comment } : {}) };
}
