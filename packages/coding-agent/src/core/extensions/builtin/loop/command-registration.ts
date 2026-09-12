/**
 * `/loop` command registration: metadata, argument hint, and subcommand completions.
 */

import type { ExtensionAPI } from "../../types.ts";
import {
	completeLoopArguments,
	LOOP_ARGUMENT_HINT,
	LOOP_COMMAND_DESCRIPTION,
	type LoopCommandDeps,
	runLoopCommand,
} from "./command.ts";

export function registerLoopCommand(pi: ExtensionAPI, deps: LoopCommandDeps): void {
	pi.registerCommand("loop", {
		description: LOOP_COMMAND_DESCRIPTION,
		argumentHint: LOOP_ARGUMENT_HINT,
		getArgumentCompletions: completeLoopArguments,
		handler: (rawArgs, ctx) => runLoopCommand(rawArgs, ctx, deps),
	});
}
