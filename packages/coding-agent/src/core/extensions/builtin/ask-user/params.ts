import { Type } from "typebox";

const CODEX_OPTION = Type.Object(
	{
		label: Type.String({ description: "User-facing label (1-5 words)." }),
		description: Type.String({
			description: "One short sentence explaining impact/tradeoff if selected.",
		}),
	},
	{ additionalProperties: false },
);

const CODEX_QUESTION = Type.Object(
	{
		id: Type.String({
			pattern: "^[a-z][a-z0-9]*(_[a-z0-9]+)*$",
			description: "Stable identifier for mapping answers (snake_case).",
		}),
		header: Type.String({
			minLength: 1,
			maxLength: 12,
			description: "Short header label shown in the UI (12 or fewer chars).",
		}),
		question: Type.String({
			minLength: 1,
			description: "Single-sentence prompt shown to the user.",
		}),
		options: Type.Array(CODEX_OPTION, {
			minItems: 2,
			maxItems: 3,
			description:
				'Provide 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with "(Recommended)". Do not include an "Other" option in this list; the client will add a free-form "Other" option automatically.',
		}),
		multiSelect: Type.Optional(
			Type.Boolean({
				description: "Set to true to allow the user to select multiple options instead of just one.",
			}),
		),
	},
	{ additionalProperties: false },
);

export const CODEX_PARAMS = Type.Object(
	{
		questions: Type.Array(CODEX_QUESTION, {
			minItems: 1,
			maxItems: 3,
			description: "Questions to show the user. Prefer 1 and do not exceed 3",
		}),
		wait_for_answer: Type.Boolean({
			description:
				"Set true to pause here until the user answers; set false to keep working and receive the answer later as a user message.",
		}),
	},
	{ additionalProperties: false },
);

const CLAUDE_OPTION = Type.Object({
	label: Type.String({
		description:
			"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.",
	}),
	description: Type.Optional(
		Type.String({
			description:
				"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
		}),
	),
});

const CLAUDE_QUESTION = Type.Object({
	question: Type.String({
		minLength: 1,
		description:
			'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
	}),
	header: Type.String({
		minLength: 1,
		maxLength: 12,
		description:
			'Very short label displayed as a chip/tag (max 12 chars). Examples: "Auth method", "Library", "Approach".',
	}),
	options: Type.Optional(
		Type.Array(CLAUDE_OPTION, {
			minItems: 2,
			maxItems: 4,
			description:
				"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no Other option, that will be provided automatically.",
		}),
	),
	multiSelect: Type.Boolean({
		description:
			"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
	}),
});

export const CLAUDE_PARAMS = Type.Object({
	questions: Type.Array(CLAUDE_QUESTION, {
		minItems: 1,
		maxItems: 4,
		description: "Questions to ask the user (1-4 questions)",
	}),
	waitForAnswer: Type.Boolean({
		description:
			"Set true to pause here until the user answers; set false to keep working and receive the answer later as a user message.",
	}),
});
