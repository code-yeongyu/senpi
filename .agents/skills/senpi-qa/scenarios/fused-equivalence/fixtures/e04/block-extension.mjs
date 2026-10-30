// E04 fixture, second extension: hook2, which records its turn and blocks the call whose shimmed value is 7.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export default function blockExtension(pi) {
	pi.on("tool_call", (event, ctx) => {
		appendFileSync(join(ctx.cwd, "trace.log"), `hook2(${event.input.value})\n`);
		if (event.input.value === 7) return { block: true, reason: "E04 hook2 blocks value 7" };
		return undefined;
	});
}
