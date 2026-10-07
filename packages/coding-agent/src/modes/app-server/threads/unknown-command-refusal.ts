import { UNKNOWN_COMMAND_CONFIRM_HINT, UnknownCommandError } from "../../../core/unknown-command.ts";
import { RPC_ERROR_UNKNOWN_COMMAND } from "../../rpc/rpc-types.ts";
import { TurnEngineError } from "./turn-runtime.ts";

export function unknownCommandTurnError(error: unknown): TurnEngineError | undefined {
	if (!(error instanceof UnknownCommandError)) return undefined;
	return new TurnEngineError({
		code: -32602,
		message: `${error.message} ${UNKNOWN_COMMAND_CONFIRM_HINT}`,
		data: {
			errorCode: RPC_ERROR_UNKNOWN_COMMAND,
			command: error.command,
			suggestions: [...error.suggestions],
			reason: error.reason,
		},
	});
}
