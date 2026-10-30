// SC-LIVE hook fixture (PreToolUse and PostToolUse, matcher "*"): appends one JSON line per firing to the trace,
// naming the hook event and the tool call it fired for. It prints nothing, so it never changes a call or its result.
//   node hook.mjs <trace file>
import { appendFileSync } from "node:fs";

const [tracePath] = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	stdin += chunk;
});
process.stdin.on("end", () => {
	const input = JSON.parse(stdin);
	const line = { event: input.hook_event_name, toolCallId: input.tool_use_id, toolName: input.tool_name };
	appendFileSync(tracePath, `${JSON.stringify(line)}\n`);
});
