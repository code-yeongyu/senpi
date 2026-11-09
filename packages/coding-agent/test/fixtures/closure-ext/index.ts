// G5 fixture (characterization, plan P0-02b): one unmodified extension whose loop-side handler
// (`before_agent_start`) and tool-side handlers (`tool_call`, `tool_result`) share one closure.
// It is loaded by path, never edited per placement; later placement tests load this same file.
import type { ExtensionAPI } from "../../../src/index.ts";

export default function closureExtension(pi: ExtensionAPI): void {
	let n = 0;
	let lastResultN: number | undefined;

	pi.on("before_agent_start", (event) => {
		n++;
		return { systemPrompt: `${event.systemPrompt}\nclosure-ext turn=${n} lastResultN=${lastResultN ?? "none"}` };
	});

	pi.on("tool_call", (event) => {
		Object.assign(event.input, { n });
	});

	pi.on("tool_result", () => {
		lastResultN = n;
		return { details: { n } };
	});
}
