import chalk from "chalk";
import { isBunRuntime } from "../../config.ts";

/** The one steering message a Node process gets when it would open session state (K9.a, senpi#5822). */
export const NODE_REQUIRES_BUN_MESSAGE =
	"senpi stores sessions in a durable store that runs on Bun, and this process is running on Node.js. " +
	"Install the senpi binary (recommended), or install Bun 1.4 or newer and run senpi with it.";

/** The variable that keeps the legacy JSONL session store on Node: a Node-only developer hatch. */
const SESSION_STORE_ENV_VAR = "SENPI_SESSION_STORE";

/** True on Node when the developer hatch asks for the legacy JSONL store. Bun ignores the variable. */
export function nodeJsonlHatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return !isBunRuntime && env[SESSION_STORE_ENV_VAR] === "jsonl";
}

/** Whether this process may open session state: always on Bun, and on Node only under the hatch. */
function sessionStateAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return isBunRuntime || nodeJsonlHatchEnabled(env);
}

/**
 * The CLI's one exit where it would open session state on Node: the steering message on stderr and exit code 1, before
 * any session file or store exists. Called after the Bun re-exec attempt, by every CLI path that opens sessions.
 */
export function exitUnlessSessionStateAvailable(): void {
	if (sessionStateAvailable()) return;
	console.error(chalk.red(NODE_REQUIRES_BUN_MESSAGE));
	process.exit(1);
}
