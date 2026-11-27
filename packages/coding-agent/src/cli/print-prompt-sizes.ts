import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { measurePromptSizes } from "../engine/prompt-sizes.ts";
import { exitAfterOutput } from "./print-then-exit.ts";

/** A full session open, followed only by preview composition; never starts a turn. */
export async function printPromptSizes(runtime: AgentSessionRuntime): Promise<never> {
	let result: Awaited<ReturnType<typeof measurePromptSizes>>;
	try {
		result = await measurePromptSizes(runtime);
	} finally {
		await runtime.dispose();
	}
	const output = result.kind === "ok" ? result.value : { error: { reason: result.error.message } };
	writeRawStdout(`${JSON.stringify(output, null, 2)}\n`);
	await flushRawStdout();
	return exitAfterOutput("", result.kind === "ok" ? 0 : 1);
}
