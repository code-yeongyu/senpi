import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";
import type { ExtensionAPI, ExtensionContext } from "../types.js";

type TodoItem = {
	content: string;
	status: string;
	priority: string;
};

type TodoWriteDetails = {
	todos: TodoItem[];
};

type TodoStateEntry = {
	todos: TodoItem[];
};

export const TODO_STATE_ENTRY_TYPE = "sanepi.todo-state";

const TodoReadParams = Type.Object({});

const DESCRIPTION = `Use this tool to create and manage a structured task list for tracking progress on multi-step work.

<todo_format>
## Todo Format (MANDATORY)

Each todo title MUST encode four elements: WHERE, WHY, HOW, and EXPECTED RESULT.

Format: "[WHERE] [HOW] to [WHY] - expect [RESULT]"

GOOD:
- "src/utils/validation.ts: Add validateEmail() for input sanitization - returns boolean"
- "UserService.create(): Call validateEmail() before DB insert - rejects invalid emails with 400"
- "validation.test.ts: Add test for missing @ sign - expect validateEmail('foo') to return false"

BAD:
- "Implement email validation" (where? how? what result?)
- "Add dark mode" (feature, not a todo)
- "Fix auth" (what file? what changes? what's expected?)
</todo_format>

<granularity_rules>
## Granularity Rules

Each todo MUST be a single atomic action completable in 1-3 tool calls. If it needs more, split it.

**Size test**: Can you complete this todo by editing one file or running one command? If not, it's too big.
</granularity_rules>

<task_management>
## Task Management
- One in_progress at a time. Complete it before starting the next.
- Mark completed immediately after finishing each item.
- Skip this tool for single trivial tasks (one-step, obvious action).
</task_management>`;

const TodoItemSchema = Type.Object({
	content: Type.String({
		description:
			"Todo title encoding WHERE, WHY, HOW, and EXPECTED RESULT. Format: '[WHERE] [HOW] to [WHY] - expect [RESULT]'. Must be a single atomic action completable in 1-3 tool calls.",
	}),
	status: Type.String({
		description:
			"Current status: pending (not started), in_progress (currently working - limit ONE at a time), completed (finished - mark IMMEDIATELY after done), cancelled (no longer needed)",
	}),
	priority: Type.String({
		description:
			"Priority level: high (blocking or critical path), medium (important but not blocking), low (nice to have)",
	}),
});

const TodoWriteParams = Type.Object({
	todos: Type.Array(TodoItemSchema, { description: "The updated todo list" }),
});

const TASK_MANAGEMENT_SECTION = `
<Task_Management>
## Todo Management (CRITICAL)

**DEFAULT BEHAVIOR**: Create todos BEFORE starting any non-trivial task. This is your PRIMARY coordination mechanism.

<todo_creation_triggers>
### When to Create Todos (MANDATORY)

- Multi-step task (2+ steps) -> ALWAYS create todos first
- Uncertain scope -> ALWAYS (todos clarify thinking)
- User request with multiple items -> ALWAYS
- Complex single task -> Create todos to break down
</todo_creation_triggers>

<todo_workflow>
### Workflow (NON-NEGOTIABLE)

1. **IMMEDIATELY on receiving request**: \`todowrite\` to plan atomic steps.
   - ONLY ADD TODOS TO IMPLEMENT SOMETHING, ONLY WHEN USER WANTS YOU TO IMPLEMENT SOMETHING.
2. **Before starting each step**: Mark \`in_progress\` (only ONE at a time)
3. **After completing each step**: Mark \`completed\` IMMEDIATELY (NEVER batch)
4. **If scope changes**: Update todos before proceeding

### Why This Is Non-Negotiable

- **User visibility**: User sees real-time progress, not a black box
- **Prevents drift**: Todos anchor you to the actual request
- **Recovery**: If interrupted, todos enable seamless continuation
- **Accountability**: Each todo = explicit commitment
</todo_workflow>

<todo_anti_patterns>
### Anti-Patterns (BLOCKING)

- Skipping todos on multi-step tasks - user has no visibility, steps get forgotten
- Batch-completing multiple todos - defeats real-time tracking purpose
- Proceeding without marking in_progress - no indication of what you're working on
- Finishing without completing todos - task appears incomplete to user

**FAILURE TO USE TODOS ON NON-TRIVIAL TASKS = INCOMPLETE WORK.**
</todo_anti_patterns>

<pre_implementation>
### Pre-Implementation Todo Requirements

0. If task has 2+ steps -> Create todo list IMMEDIATELY, IN SUPER DETAIL. No announcements-just create it.
1. Mark current task \`in_progress\` before starting
2. Mark \`completed\` as soon as done (don't batch) - OBSESSIVELY TRACK YOUR WORK USING TODO TOOLS
</pre_implementation>

<evidence_requirements>
### Evidence Requirements (task NOT complete without these)

- **File edit** -> Diagnostics clean on changed files
- **Build command** -> Exit code 0
- **Test run** -> Pass (or explicit note of pre-existing failures)

**NO EVIDENCE = NOT COMPLETE.**
</evidence_requirements>

<verification_anti_patterns>
### Verification Anti-Patterns (BLOCKING)

| Violation | Why It Fails |
|-----------|--------------|
| "It should work now" | No evidence. Run it. |
| "I added the tests" | Did they pass? Show output. |
| "Fixed the bug" | How do you know? What did you test? |
| "Implementation complete" | Did you verify against success criteria? |

**CLAIM NOTHING WITHOUT PROOF. EXECUTE. VERIFY. SHOW EVIDENCE.**
</verification_anti_patterns>

<completion_checklist>
### Completion Checklist

A task is complete when:
- [ ] All planned todo items marked done
- [ ] Diagnostics clean on changed files
- [ ] Build passes (if applicable)
- [ ] User's original request fully addressed
</completion_checklist>
</Task_Management>
`;

function countOpenTodos(todos: TodoItem[]): number {
	return todos.filter((todo) => todo.status !== "completed").length;
}

function sanitizeTodoText(text: string): string {
	return stripAnsi(text)
		.replace(/[\r\n]+/g, " ")
		.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function getTodoMarker(status: string): string {
	if (status === "completed") return "[✓]";
	if (status === "in_progress") return "[•]";
	return "[ ]";
}

function getTodoWidgetLines(todos: TodoItem[]): string[] | undefined {
	if (todos.length === 0 || !todos.some((todo) => todo.status !== "completed")) {
		return undefined;
	}
	return ["Todo", ...todos.map((todo) => `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`)];
}

function getTodoResultLines(todos: TodoItem[]): string[] {
	return [
		`${countOpenTodos(todos)} todos`,
		...todos.map((todo) => `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`),
	];
}

function isTodoItem(value: unknown): value is TodoItem {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const item = value as Record<string, unknown>;
	return typeof item.content === "string" && typeof item.status === "string" && typeof item.priority === "string";
}

function isTodoItemArray(value: unknown): value is TodoItem[] {
	return Array.isArray(value) && value.every(isTodoItem);
}

function getLatestTodosFromBranchEntries(
	entries: Array<{ type: string; customType?: string; data?: unknown; message?: unknown }>,
): TodoItem[] {
	let todos: TodoItem[] = [];

	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === TODO_STATE_ENTRY_TYPE) {
			const data = entry.data as TodoStateEntry | undefined;
			if (isTodoItemArray(data?.todos)) {
				todos = data.todos.map((todo) => ({ ...todo }));
			}
			continue;
		}

		if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) {
			continue;
		}

		const message = entry.message as { role?: string; toolName?: string; details?: unknown };
		if (message.role !== "toolResult" || message.toolName !== "todowrite") continue;

		const details = message.details as TodoWriteDetails | undefined;
		if (isTodoItemArray(details?.todos)) {
			todos = details.todos.map((todo) => ({ ...todo }));
		}
	}

	return todos;
}

function getLatestTodos(ctx: ExtensionContext): TodoItem[] {
	return getLatestTodosFromBranchEntries(ctx.sessionManager.getBranch());
}

export default function todowriteExtension(pi: ExtensionAPI): void {
	let currentTodos: TodoItem[] = [];

	const syncWidget = (ctx: ExtensionContext): void => {
		ctx.ui.setWidget("todo-sidebar", getTodoWidgetLines(currentTodos));
	};

	const syncFromSession = (ctx: ExtensionContext): void => {
		currentTodos = getLatestTodos(ctx);
		syncWidget(ctx);
	};

	pi.on("session_start", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		syncFromSession(ctx);
	});

	pi.on("before_agent_start", async (event) => {
		return {
			systemPrompt: `${event.systemPrompt}\n${TASK_MANAGEMENT_SECTION}`,
		};
	});

	pi.registerTool({
		name: "todowrite",
		label: "TodoWrite",
		description: DESCRIPTION,
		promptSnippet:
			"MANDATORY for multi-step work (2+ steps). Create and track structured todos with WHERE/WHY/HOW/RESULT format. Mark completed IMMEDIATELY after each step.",
		promptGuidelines: [
			"Create todos BEFORE any non-trivial task (2+ steps). This is MANDATORY, not optional. Do it IMMEDIATELY on receiving the request - no announcements, just create.",
			"Each todo title MUST encode WHERE, WHY, HOW, and EXPECTED RESULT. Format: '[WHERE] [HOW] to [WHY] - expect [RESULT]'. Vague todos are useless.",
			"Each todo MUST be a single atomic action completable in 1-3 tool calls. If bigger, split it. Size test: one file edit or one command.",
			"Pass the complete updated todo list on every call instead of incremental operations.",
			"Exactly ONE todo with status in_progress at any time. Mark completed IMMEDIATELY after finishing - NEVER batch completions.",
			"OBSESSIVELY TRACK YOUR WORK. Every step gets a todo. Every completion gets marked immediately. No evidence = not complete.",
		],
		parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentTodos = params.todos.map((todo) => ({ ...todo }));
			pi.appendEntry(TODO_STATE_ENTRY_TYPE, { todos: currentTodos } satisfies TodoStateEntry);
			syncWidget(ctx);

			return {
				content: [{ type: "text", text: JSON.stringify(currentTodos, null, 2) }],
				details: { todos: currentTodos } satisfies TodoWriteDetails,
			};
		},
		renderCall(args, theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("todowrite ")) + theme.fg("muted", `${args.todos.length} item(s)`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const details = result.details as TodoWriteDetails | undefined;
			const todos = details?.todos ?? currentTodos;
			const [title, ...items] = getTodoResultLines(todos);
			const body = items.length > 0 ? `\n${items.join("\n")}` : "";
			return new Text(`${theme.fg("muted", title)}${body}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "todoread",
		label: "TodoRead",
		description: "Read the current structured task list for the current coding session.",
		promptSnippet: "Read the current todo list for the active coding session.",
		promptGuidelines: [
			"Use this tool when you need the current todo list before deciding how to update it.",
			"This tool returns the latest session todo list managed by todowrite.",
		],
		parameters: TodoReadParams,
		async execute() {
			return {
				content: [{ type: "text", text: JSON.stringify(currentTodos, null, 2) }],
				details: { todos: currentTodos } satisfies TodoWriteDetails,
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("todoread")), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as TodoWriteDetails | undefined;
			const todos = details?.todos ?? currentTodos;
			const [title, ...items] = getTodoResultLines(todos);
			const body = items.length > 0 ? `\n${items.join("\n")}` : "";
			return new Text(`${theme.fg("muted", title)}${body}`, 0, 0);
		},
	});
}
