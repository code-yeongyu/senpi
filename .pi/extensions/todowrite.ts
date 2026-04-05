import { type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";

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
   content: Type.String({ description: "Todo title encoding WHERE, WHY, HOW, and EXPECTED RESULT. Format: '[WHERE] [HOW] to [WHY] - expect [RESULT]'. Must be a single atomic action completable in 1-3 tool calls." }),
   status: Type.String({ description: "Current status: pending (not started), in_progress (currently working - limit ONE at a time), completed (finished - mark IMMEDIATELY after done), cancelled (no longer needed)" }),
   priority: Type.String({ description: "Priority level: high (blocking or critical path), medium (important but not blocking), low (nice to have)" }),
});

const TodoWriteParams = Type.Object({
   todos: Type.Array(TodoItemSchema, { description: "The updated todo list" }),
});


function countOpenTodos(todos: TodoItem[]): number {
   return todos.filter((todo) => todo.status !== "completed").length;
}

export function sanitizeTodoText(text: string): string {
	return stripAnsi(text).replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
}

function getTodoMarker(status: string): string {
   if (status === "completed") return "[✓]";
   if (status === "in_progress") return "[•]";
   return "[ ]";
}

export function getTodoWidgetLines(todos: TodoItem[]): string[] | undefined {
   if (todos.length === 0 || !todos.some((todo) => todo.status !== "completed")) {
      return undefined;
   }

	return ["Todo", ...todos.map((todo) => `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`)];
}

export function getTodoResultLines(todos: TodoItem[]): string[] {
	return [`${countOpenTodos(todos)} todos`, ...todos.map((todo) => `${getTodoMarker(todo.status)} ${sanitizeTodoText(todo.content)}`)];
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

export function getLatestTodosFromBranchEntries(entries: Array<{ type: string; customType?: string; data?: unknown; message?: unknown }>): TodoItem[] {
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

    pi.registerTool({
       name: "todowrite",
       label: "TodoWrite",
       description: DESCRIPTION,
       promptSnippet: "Create and manage a structured task list for the current coding session.",
       promptGuidelines: [
          "Use this tool for complex multi-step work, typically when a task has 3 or more distinct steps.",
          "Pass the complete updated todo list on every call instead of incremental operations.",
          "Prefer exactly one todo with status in_progress and mark tasks completed immediately after finishing them.",
       ],
      parameters: TodoWriteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			currentTodos = params.todos.map((todo) => ({ ...todo }));
			pi.appendEntry(TODO_STATE_ENTRY_TYPE, { todos: currentTodos } satisfies TodoStateEntry);
			syncWidget(ctx);

         return {
            content: [
               {
                  type: "text",
                  text: JSON.stringify(currentTodos, null, 2),
               },
            ],
            details: {
               todos: currentTodos,
            } satisfies TodoWriteDetails,
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
            content: [
               {
                  type: "text",
                  text: JSON.stringify(currentTodos, null, 2),
               },
            ],
            details: {
               todos: currentTodos,
            } satisfies TodoWriteDetails,
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
