// SC-LIVE task prompts (plan §3.4): one long multi-tool session in the fixture repo, sent as 8 user turns. Each turn
// names the tools it needs, so a real model exercises every surface SC-LIVE requires: parallel reads, sequential bash,
// edits, the `with-deps` extension's tool, an MCP fixture tool, an `ask_user` question answered over RPC, and a sub-agent.
// The self-test's fake model (self-test-turns.mjs) answers the same 8 turns.

export const LIVE_PROMPTS = [
	"You are working in a small fixture repo. In ONE batch of parallel read calls, read README.md, TASK.md, package.json, src/strings.mjs, src/math.mjs and src/list.mjs. Then summarize the task in two sentences.",
	"With the bash tool, run `node --test` once, then run `node --test test/strings.test.mjs` and then `node --test test/math.test.mjs` as separate, sequential bash calls. Report which tests fail.",
	"Read test/strings.test.mjs and test/math.test.mjs in parallel. Fix src/strings.mjs and src/math.mjs with the edit tool (never edit the tests), then run `node --test test/strings.test.mjs test/math.test.mjs` with bash.",
	"Read test/list.test.mjs, fix src/list.mjs with the edit tool, then run `node --test` with bash to confirm every test passes.",
	"Call the parse_duration tool for '2 days' and for '90m'. Then create NOTES.md with the write tool containing exactly two lines: `duration: 2 days = <ms>` and `duration: 90m = <ms>`, using the milliseconds the tool returned.",
	"Call the MCP tool mcp_fxstdio_tool_1 with value 'live-mcp'. Read NOTES.md, then append one line `mcp: <the text the tool returned>` with the edit tool.",
	"Ask me which license the fixture should use with your question tool: one question, header 'License', options 'MIT' and 'Apache-2.0', wait for my answer. Then append `license: <my answer>` to NOTES.md with the edit tool.",
	"Read src/strings.mjs, src/math.mjs and src/list.mjs in parallel. Then use the task tool to run ONE sub-agent with the prompt 'Count the exported functions in src/ of this repo and answer with just the number.' Append `subagent: <its answer>` to NOTES.md with the edit tool, and finally run `node --test` with bash.",
];
