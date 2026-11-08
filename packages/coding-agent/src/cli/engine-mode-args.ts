import type { Args } from "./args.ts";

/**
 * `--hand` and `--headless` (senpi#5840) start the engine on its own endpoint, speaking its own protocol: both run in
 * RPC mode (nothing reaches stdout), `--headless` as a multi-session host. What would ask the engine for a prompt, a
 * print run or a text/json stream is refused.
 */
export function applyEngineModeArgs(args: Args): void {
	if (!args.hand && !args.headless) return;
	const error = (message: string) => args.diagnostics.push({ type: "error", message });
	if (args.hand && args.headless) {
		error("--hand and --headless cannot be combined");
		return;
	}
	const flag = args.hand ? "--hand" : "--headless";
	if (args.print || args.readStdin || args.messages.length > 0 || args.fileArgs.length > 0)
		error(`${flag} serves its own endpoint; omit --print, stdin input, prompt arguments and @files`);
	if (args.mode !== undefined && args.mode !== "rpc")
		error(`${flag} speaks its own protocol and cannot be combined with --mode ${args.mode}`);
	if (args.hand && (args.listen !== undefined || args.multiSession))
		error("--hand listens on its own endpoint; omit --listen and --multi-session");
	args.mode = "rpc";
	if (args.headless) args.multiSession = true;
}
