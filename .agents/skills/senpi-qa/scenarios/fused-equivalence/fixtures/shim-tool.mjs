// E07 fixture: a tool whose prepareArguments shim turns the legacy `{legacy: "42"}` shape into `{value: 42}` before
// validation; the body echoes what it received.
import { Type } from "typebox";

export default function shimTool(pi) {
	pi.registerTool({
		name: "eq_shim",
		label: "EQ shim",
		description: "EQ fixture: accepts {value:number}; legacy {legacy:string} is shimmed.",
		parameters: Type.Object({ value: Type.Number() }),
		prepareArguments(args) {
			if (typeof args === "object" && args !== null && "legacy" in args) return { value: Number(args.legacy) };
			return args;
		},
		async execute(_toolCallId, params) {
			return { content: [{ type: "text", text: `shim:${typeof params.value}:${params.value}` }], details: {} };
		},
	});
}
