// E04 shell hook (PreToolUse and PostToolUse): appends "<event>" to the trace and keeps the stdin it got. As a
// PostToolUse hook it replaces the tool output (`updatedToolOutput`), the mutation E04 pins.
//   node shell-hook.mjs <pre|post> <trace file>
import { appendFileSync } from "node:fs";

const [kind, tracePath] = process.argv.slice(2);
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	stdin += chunk;
});
process.stdin.on("end", () => {
	const input = JSON.parse(stdin);
	appendFileSync(tracePath, `${kind}(${JSON.stringify(input.tool_input)})\n`);
	if (kind === "post")
		process.stdout.write(JSON.stringify({ updatedToolOutput: `post-mutated:${JSON.stringify(input.tool_input)}` }));
});
