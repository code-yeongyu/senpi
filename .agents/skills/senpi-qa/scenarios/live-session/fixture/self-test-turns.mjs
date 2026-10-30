// The fake model's side of the SC-LIVE self-test: deterministic turns that do the fixture task exactly, answering the
// 8 LIVE_PROMPTS in order (every turn ending a prompt is a text turn). 31 tool calls; the edits produce a repo whose
// checker passes. The fake server consumes turns in order, so this list is the whole session.
const call = (id, name, args) => ({ id, name, args });
const read = (id, path) => call(id, "read", { path });
/** Today's CLI exposes bash to the model inside eval cells (`tool.bash`), as a real model would call it. */
const bash = (id, command) =>
	call(id, "eval", {
		language: "js",
		summary: `run ${command}`,
		code: `const out = await tool.bash({ command: ${JSON.stringify(command)} });\nprint(out.text);`,
	});
const edit = (id, path, oldText, newText) => call(id, "edit", { path, edits: [{ oldText, newText }] });
const text = (value) => ({ text: value });

export const MCP_NOTE = "mcp: fixture tool_1 live-mcp";
export const SUBAGENT_NOTE = "subagent: 4";

export function selfTestTurns() {
	return [
		// 1: parallel reads
		{
			toolCalls: ["README.md", "TASK.md", "package.json", "src/strings.mjs", "src/math.mjs", "src/list.mjs"].map(
				(path, index) => read(`p1_read_${index}`, path),
			),
		},
		text("LIVE-1: fix src/ until node --test passes and keep NOTES.md."),
		// 2: sequential bash
		{ toolCalls: [bash("p2_bash_all", "node --test")] },
		{ toolCalls: [bash("p2_bash_strings", "node --test test/strings.test.mjs")] },
		{ toolCalls: [bash("p2_bash_math", "node --test test/math.test.mjs")] },
		text("LIVE-2: every test fails."),
		// 3: reads, edits, bash
		{ toolCalls: [read("p3_read_strings", "test/strings.test.mjs"), read("p3_read_math", "test/math.test.mjs")] },
		{
			toolCalls: [
				edit(
					"p3_edit_strings",
					"src/strings.mjs",
					"return word.charAt(0) + word.slice(1);",
					"return word.charAt(0).toUpperCase() + word.slice(1);",
				),
			],
		},
		{
			toolCalls: [
				edit(
					"p3_edit_reverse",
					"src/strings.mjs",
					'return text.split("").join("");',
					'return text.split("").reverse().join("");',
				),
			],
		},
		{
			toolCalls: [
				call("p3_edit_math", "edit", {
					path: "src/math.mjs",
					edits: [
						{ oldText: "total + value, 1);", newText: "total + value, 0);" },
						{ oldText: "(values.length + 1)", newText: "values.length" },
					],
				}),
			],
		},
		{ toolCalls: [bash("p3_bash", "node --test test/strings.test.mjs test/math.test.mjs")] },
		text("LIVE-3: strings and math pass."),
		// 4: list
		{ toolCalls: [read("p4_read_list", "test/list.test.mjs")] },
		{
			toolCalls: [
				call("p4_edit_list", "edit", {
					path: "src/list.mjs",
					edits: [
						{ oldText: "index += size + 1", newText: "index += size" },
						{ oldText: "items.indexOf(item) !== index", newText: "items.indexOf(item) === index" },
					],
				}),
			],
		},
		{ toolCalls: [bash("p4_bash", "node --test")] },
		text("LIVE-4: every test passes."),
		// 5: with-deps tool, write
		{
			toolCalls: [
				call("p5_duration_2d", "parse_duration", { duration: "2 days" }),
				call("p5_duration_90m", "parse_duration", { duration: "90m" }),
			],
		},
		{
			toolCalls: [
				call("p5_write_notes", "write", {
					path: "NOTES.md",
					content: "duration: 2 days = 172800000\nduration: 90m = 5400000\n",
				}),
			],
		},
		text("LIVE-5: NOTES.md written."),
		// 6: MCP fixture tool
		{ toolCalls: [call("p6_mcp", "mcp_fxstdio_tool_1", { value: "live-mcp" })] },
		{ toolCalls: [read("p6_read_notes", "NOTES.md")] },
		{
			toolCalls: [
				edit("p6_edit_notes", "NOTES.md", "duration: 90m = 5400000\n", `duration: 90m = 5400000\n${MCP_NOTE}\n`),
			],
		},
		text("LIVE-6: MCP line added."),
		// 7: ask_user over RPC
		{
			toolCalls: [
				call("p7_question", "ask_user_question", {
					questions: [
						{
							question: "Which license should the fixture use?",
							header: "License",
							options: [{ label: "MIT" }, { label: "Apache-2.0" }],
							multiSelect: false,
						},
					],
					waitForAnswer: true,
				}),
			],
		},
		{ toolCalls: [edit("p7_edit_notes", "NOTES.md", `${MCP_NOTE}\n`, `${MCP_NOTE}\nlicense: MIT\n`)] },
		text("LIVE-7: license recorded."),
		// 8: parallel reads, sub-agent, final bash
		{
			toolCalls: ["src/strings.mjs", "src/math.mjs", "src/list.mjs"].map((path, index) =>
				read(`p8_read_${index}`, path),
			),
		},
		{
			toolCalls: [
				call("p8_task", "task", {
					prompt: "Count the exported functions in src/ of this repo and answer with just the number.",
				}),
			],
		},
		{ toolCalls: [edit("p8_edit_notes", "NOTES.md", "license: MIT\n", `license: MIT\n${SUBAGENT_NOTE}\n`)] },
		{ toolCalls: [bash("p8_bash", "node --test")] },
		text("LIVE-8: done."),
	];
}
