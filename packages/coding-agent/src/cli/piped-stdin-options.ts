import { PIPED_STDIN_GRACE_MS, type ReadPipedStdinOptions } from "../utils/piped-stdin.ts";
import type { Args } from "./args.ts";

export const PIPED_STDIN_SKIP_HINT = `stdin ignored because a prompt was given and no input arrived within ${PIPED_STDIN_GRACE_MS} ms; pass - to read stdin`;

export function pipedStdinOptions(
	parsed: Pick<Args, "messages" | "fileArgs" | "readStdin">,
	stderr: { write(text: string): unknown },
): ReadPipedStdinOptions {
	return {
		hasPromptArgument: parsed.messages.length > 0 || parsed.fileArgs.length > 0,
		forceRead: parsed.readStdin === true,
		onSkip: () => stderr.write(`${PIPED_STDIN_SKIP_HINT}\n`),
	};
}
