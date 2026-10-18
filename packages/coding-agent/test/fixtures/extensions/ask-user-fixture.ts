/**
 * QA fixture extension for the built-in question tool (`request_user_input` /
 * `ask_user_question`).
 *
 * Load it with `senpi -e <this file>` and drive the tool WITHOUT a model:
 *
 *   /askq wait=true                 blocking call, result returns as the tool result
 *   /askq wait=false                async call, answer arrives later as a user message
 *   /askq wait=true n=1 label=step1 one question only, tagged in the fixture log
 *   /askq wait=false n=1 header=Alpha q="Choose a database" overrides the first question
 *
 * The command dispatches `pi.executeTool` and returns immediately, so the RPC
 * `prompt` response never waits on the user. Every call, tool result and failure
 * is appended as one JSON line to `$SENPI_ASK_USER_FIXTURE_LOG` (default
 * `<agentDir>/ask-user-fixture.jsonl`), which is what the RPC probe asserts on;
 * the one-line `notify` is for the TUI visual QA lane.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type {
	ExecuteToolResult,
	ExtensionAPI,
	ExtensionCommandContext,
	QuestionRequest,
} from "../../../src/core/extensions/types.ts";

/** Wait-flag parameter name per tool family; both are REQUIRED by the tool schema. */
const WAIT_FLAGS: Record<string, string> = {
	request_user_input: "wait_for_answer",
	ask_user_question: "waitForAnswer",
};

/**
 * Two questions that satisfy BOTH variant schemas (codex: snake_case ids,
 * described options, <= 3 questions; claude: multiSelect required). Answering
 * only `q1` therefore leaves exactly `q2` unanswered.
 */
const QUESTIONS: QuestionRequest["questions"] = [
	{
		id: "q1",
		header: "Database",
		question: "Which database should I use?",
		options: [
			{ label: "PostgreSQL", description: "Relational, managed" },
			{ label: "SQLite", description: "Embedded, zero ops" },
		],
		multiSelect: false,
	},
	{
		id: "q2",
		header: "Deploy",
		question: "Where should it deploy?",
		options: [
			{ label: "Fly", description: "Edge machines" },
			{ label: "Render", description: "Single region" },
		],
		multiSelect: false,
	},
];

interface FixtureArgs {
	wait: boolean | undefined;
	count: number;
	label: string;
	header: string | undefined;
	question: string | undefined;
}

function parseArgs(raw: string): FixtureArgs {
	let wait: boolean | undefined;
	let count = QUESTIONS.length;
	let label = "askq";
	let header: string | undefined;
	let question: string | undefined;
	for (const match of raw.matchAll(/(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g)) {
		const [, key, doubleQuoted, singleQuoted, unquoted] = match;
		const value = doubleQuoted ?? singleQuoted ?? unquoted;
		if (key === "wait") wait = value === "true";
		else if (key === "n") count = Number(value);
		else if (key === "label" && value) label = value;
		else if (key === "header") header = value;
		else if (key === "q") question = value;
	}
	return { wait, count, label, header, question };
}

function logPath(ctx: ExtensionCommandContext): string {
	return process.env.SENPI_ASK_USER_FIXTURE_LOG ?? join(ctx.agentDir, "ask-user-fixture.jsonl");
}

function record(ctx: ExtensionCommandContext, entry: Record<string, unknown>): void {
	appendFileSync(logPath(ctx), `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

function resultText(result: ExecuteToolResult): string {
	return result.content.map((part) => (part.type === "text" ? part.text : `[${part.type}]`)).join("\n");
}

export default function askUserFixture(pi: ExtensionAPI): void {
	pi.registerCommand("askq", {
		description: "QA: call the built-in question tool directly (wait=true|false)",
		argumentHint: "wait=true|false [n=1|2] [header=<text>] [q=<text>] [label=<tag>]",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const { wait, count, label, header, question: questionText } = parseArgs(args);
			if (wait === undefined) {
				ctx.ui.notify("Usage: /askq wait=true|false [n=1|2] [header=<text>] [q=<text>] [label=<tag>]", "warning");
				return;
			}
			const tool = pi.getActiveTools().find((name) => name in WAIT_FLAGS);
			if (!tool) {
				record(ctx, { event: "unavailable", label, activeTools: pi.getActiveTools() });
				ctx.ui.notify("No question tool is active", "error");
				return;
			}
			const questions = QUESTIONS.slice(0, count).map((question, index) =>
				index === 0
					? {
							...question,
							...(header === undefined ? {} : { header }),
							...(questionText === undefined ? {} : { question: questionText }),
						}
					: question,
			);
			const params = { [WAIT_FLAGS[tool] ?? "waitForAnswer"]: wait, questions };
			record(ctx, { event: "call", label, tool, wait, questionCount: params.questions.length });
			void pi.executeTool(tool, params).then(
				(result) => {
					record(ctx, { event: "result", label, tool, text: resultText(result), details: result.details });
					ctx.ui.notify(`[askq ${label}] tool result received`, "info");
				},
				(error: unknown) => {
					record(ctx, {
						event: "failed",
						label,
						tool,
						error: error instanceof Error ? error.message : String(error),
					});
					ctx.ui.notify(`[askq ${label}] tool call failed`, "error");
				},
			);
		},
	});
}
