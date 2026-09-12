export { CLAUDE_PARAMS, CODEX_PARAMS } from "./params.ts";

// TODO(t3-merge): re-export from ../../types.ts
export interface QuestionRequest {
	requestId: string;
	questions: Array<{
		id: string;
		header: string;
		question: string;
		options: Array<{ label: string; description?: string }>;
		multiSelect: boolean;
	}>;
	waitForAnswer: boolean;
	timeoutMs: number;
}

// TODO(t3-merge): re-export from ../../types.ts
export interface QuestionResponse {
	status: "answered" | "comment-submitted" | "timed_out" | "cancelled" | "orphaned-after-restart" | "unavailable";
	answers: Record<string, { selected: string[]; text?: string }>;
	comment?: string;
	unanswered: string[];
	autoResolvedAfterMs?: number;
}

export type AskUserVariant = "codex" | "claude";
export type Question = QuestionRequest["questions"][number];
export type QuestionOption = Question["options"][number];

export const WAIT_FLAG_STEER_TEXT =
	"This call omitted wait_for_answer (or waitForAnswer). Set true to pause here until the user answers, false to keep working and receive the answer later as a user message.";

export const DEFAULT_ASK_USER_TIMEOUT_MS = 30 * 60 * 1000;

const HEADER_MAX = 12;
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const LIMITS = {
	codex: { maxQuestions: 3, minOptions: 2, maxOptions: 3, optionsRequired: true },
	claude: { maxQuestions: 4, minOptions: 2, maxOptions: 4, optionsRequired: false },
} as const;

export class AskUserSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AskUserSchemaError";
	}
}

export type ToCanonicalOptions = {
	requestId?: string;
	timeoutMs?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readWaitFlag(variant: AskUserVariant, args: Record<string, unknown>): boolean {
	const value = args[variant === "codex" ? "wait_for_answer" : "waitForAnswer"];
	if (typeof value !== "boolean") {
		throw new AskUserSchemaError(WAIT_FLAG_STEER_TEXT);
	}
	return value;
}

function parseOptions(
	raw: unknown,
	min: number,
	max: number,
	required: boolean,
	requireDescription: boolean,
): QuestionOption[] {
	if (raw === undefined) {
		if (required) throw new AskUserSchemaError(`options must contain ${min} to ${max} items`);
		return [];
	}
	if (!Array.isArray(raw)) throw new AskUserSchemaError("options must be an array");
	if (raw.length < min || raw.length > max) {
		throw new AskUserSchemaError(
			required
				? `options must contain ${min} to ${max} items`
				: `options must contain ${min} to ${max} items when present`,
		);
	}
	const options: QuestionOption[] = [];
	for (const item of raw) {
		if (!isRecord(item)) throw new AskUserSchemaError("each option must be an object");
		const label = typeof item.label === "string" ? item.label.trim() : "";
		if (label.length === 0) throw new AskUserSchemaError("option label must be non-empty");
		const description = typeof item.description === "string" ? item.description.trim() : undefined;
		if (requireDescription && (description === undefined || description.length === 0)) {
			throw new AskUserSchemaError("option description is required");
		}
		options.push(description === undefined || description.length === 0 ? { label } : { label, description });
	}
	return options;
}

function parseQuestion(variant: AskUserVariant, raw: unknown, index: number): Question {
	if (!isRecord(raw)) throw new AskUserSchemaError("each question must be an object");
	const limits = LIMITS[variant];
	const header = typeof raw.header === "string" ? raw.header.trim() : "";
	if (header.length === 0) throw new AskUserSchemaError("header must be non-empty");
	if (header.length > HEADER_MAX) throw new AskUserSchemaError("header must be 12 or fewer characters");
	const question = typeof raw.question === "string" ? raw.question.trim() : "";
	if (question.length === 0) throw new AskUserSchemaError("question must be non-empty");
	const options = parseOptions(
		raw.options,
		limits.minOptions,
		limits.maxOptions,
		limits.optionsRequired,
		variant === "codex",
	);
	let id: string;
	if (variant === "claude") {
		id = `q${index + 1}`;
	} else {
		id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (!SNAKE_CASE.test(id)) throw new AskUserSchemaError("id must be snake_case");
	}
	let multiSelect: boolean;
	if (variant === "claude") {
		if (typeof raw.multiSelect !== "boolean") throw new AskUserSchemaError("multiSelect is required");
		multiSelect = raw.multiSelect;
	} else {
		multiSelect = raw.multiSelect === true;
	}
	return { id, header, question, options, multiSelect };
}

export function toCanonical(variant: AskUserVariant, args: unknown, options?: ToCanonicalOptions): QuestionRequest {
	if (!isRecord(args)) throw new AskUserSchemaError(WAIT_FLAG_STEER_TEXT);
	const waitForAnswer = readWaitFlag(variant, args);
	const limits = LIMITS[variant];
	if (!Array.isArray(args.questions) || args.questions.length < 1 || args.questions.length > limits.maxQuestions) {
		throw new AskUserSchemaError(`questions must contain 1 to ${limits.maxQuestions} items`);
	}
	return {
		requestId: options?.requestId ?? crypto.randomUUID(),
		questions: args.questions.map((question, index) => parseQuestion(variant, question, index)),
		waitForAnswer,
		timeoutMs: options?.timeoutMs ?? DEFAULT_ASK_USER_TIMEOUT_MS,
	};
}
