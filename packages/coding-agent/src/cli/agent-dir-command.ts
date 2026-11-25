import { APP_NAME } from "../config.ts";
import { agentDirectory } from "../engine/agent-directory.ts";
import { exitAfterOutput } from "./print-then-exit.ts";

/**
 * A metadata command, before compile-cache setup, settings, migrations, extensions or hosts.
 * The directory is the very same getAgentDir() every session uses; the remaining fields
 * describe that decision rather than choosing another directory.
 */
export async function dispatchAgentDirectoryCommand(args: readonly string[]): Promise<void> {
	if (args[0] !== "config" || args[1] !== "agent-dir") return;
	if (args.length !== 3 || args[2] !== "--json") {
		await exitAfterOutput(
			`${JSON.stringify({
				version: 1,
				ok: false,
				code: "invalid_arguments",
				message: `Usage: ${APP_NAME} config agent-dir --json`,
			})}\n`,
			2,
		);
	}
	const result = agentDirectory();
	if (result.kind === "error") {
		await exitAfterOutput(
			`${JSON.stringify({ version: 1, ok: false, code: result.error.code, message: result.error.message })}\n`,
			1,
		);
		return;
	}
	await exitAfterOutput(`${JSON.stringify(result.value)}\n`, 0);
}
