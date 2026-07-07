import { type Static, Type } from "typebox";
import { encodeKeys, TERMINAL_INPUT_TOOL } from "../shared.ts";
import { errorResult, type TerminalToolContext, type TerminalToolResult, textResult } from "./context.ts";

export const bashInputSchema = Type.Object({
	bash_id: Type.String({ description: "Session id returned by a run_in_background bash call." }),
	input: Type.Optional(Type.String({ description: "Literal text to write to the session's stdin." })),
	keys: Type.Optional(
		Type.Array(Type.String(), {
			description: "Named keys to send, e.g. ['ctrl+c'], ['enter'], ['up']. Sent after `input` when both are given.",
		}),
	),
	submit: Type.Optional(
		Type.Boolean({
			description: "Append Enter (\\r) after `input`. Default true when `input` is a non-empty string.",
		}),
	),
});

export type BashInputInput = Static<typeof bashInputSchema>;

export function createBashInputTool(ctx: TerminalToolContext) {
	return {
		name: TERMINAL_INPUT_TOOL,
		label: "bash_input",
		description:
			"Write stdin or named keys (ctrl+c, enter, up, ...) to a live background bash session — e.g. drive a REPL or send SIGINT. This executes arbitrary shell input and is permission-gated like bash.",
		promptSnippet: "Send stdin/keys to a live background bash session (REPL steering, ctrl+c, etc.)",
		parameters: bashInputSchema,
		async execute(_toolCallId: string, input: BashInputInput, _signal?: AbortSignal): Promise<TerminalToolResult> {
			const runtime = ctx.manager.get(input.bash_id);
			if (!runtime) return errorResult(`No terminal session found with id: ${input.bash_id}`);
			if (runtime.exited) return errorResult(`Session ${input.bash_id} is not running; cannot send input.`);

			const notes: string[] = [];
			if (typeof input.input === "string") {
				const submit = input.submit ?? input.input.length > 0;
				const result = runtime.session.write(submit ? `${input.input}\r` : input.input);
				if (!result.ok) return errorResult(`Failed to write input: ${result.note}`);
				notes.push(submit ? "wrote input + Enter" : "wrote input");
			}

			if (input.keys && input.keys.length > 0) {
				const { data, unknown } = encodeKeys(input.keys);
				if (data.length > 0) {
					const result = runtime.session.write(data);
					if (!result.ok) return errorResult(`Failed to send keys: ${result.note}`);
					notes.push(`sent ${input.keys.length - unknown.length} key(s)`);
				}
				if (unknown.length > 0) notes.push(`ignored unknown keys: ${unknown.join(", ")}`);
			}

			if (notes.length === 0) return errorResult("Nothing to send: provide `input` and/or `keys`.");
			return textResult(`Sent to ${input.bash_id}: ${notes.join("; ")}.`);
		},
	};
}
