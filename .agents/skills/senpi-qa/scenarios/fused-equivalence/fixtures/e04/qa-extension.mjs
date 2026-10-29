// E04 fixture, first extension: the G1 `qa` tool (search-exposed, inactive), its lazy activator, its prepareArguments
// shim (`{legacy:"42"}` -> `{value:42}`) and the first tool_call handler (hook1). Every step appends one line to
// trace.log in the session cwd, beside the shell hooks' lines, so the whole order lands in one record (O5 tree).
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

export default function qaExtension(pi) {
	let cwd = process.cwd();
	const record = (entry) => appendFileSync(join(cwd, "trace.log"), `${entry}\n`);
	pi.on("session_start", (_event, ctx) => {
		cwd = ctx.cwd;
	});
	pi.registerTool({
		name: "qa",
		label: "qa",
		description: "G1 characterization tool",
		exposure: "search",
		parameters: Type.Object({ value: Type.Number() }),
		prepareArguments(args) {
			record("shim");
			if (typeof args === "object" && args !== null && "legacy" in args) return { value: Number(args.legacy) };
			return args;
		},
		async execute(_toolCallId, params) {
			record(`body(${params.value})`);
			return { content: [{ type: "text", text: `qa:${params.value}` }], details: {} };
		},
	});
	pi.registerLazyToolActivator((toolName) => {
		if (toolName !== "qa") return false;
		record("activate");
		pi.setActiveTools([...pi.getActiveTools(), toolName]);
		return true;
	});
	pi.on("tool_call", (event) => {
		record(`hook1(${typeof event.input.value})`);
	});
}
