/**
 * A client's `open_session` of a parked session's path reopens it with the park record's launch choices wherever the
 * request names none (senpi#7380), so a session parked under `ask` never comes back under the host default. A choice
 * the request names wins. `syncRetainedRecord` still clears the record after the open.
 */
import { readHandoverParkedSessions } from "./host-handover-parked.ts";
import { parkedOpenCommand } from "./host-handover-parked-open.ts";
import type { RpcCommand } from "./rpc-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { canonicalSessionPath } from "./session-path-key.ts";

type OpenSessionCommand = Extract<RpcCommand, { type: "open_session" }>;

export async function withParkedChoices(host: RouterContext, command: OpenSessionCommand): Promise<OpenSessionCommand> {
	const dir = host.handoverParkedDir;
	if (dir === undefined || command.sessionPath === undefined) return command;
	const key = canonicalSessionPath(command.sessionPath);
	const entry = (await readHandoverParkedSessions(dir)).find(
		(candidate) => canonicalSessionPath(candidate.sessionPath) === key,
	);
	if (entry === undefined) return command;
	const recorded = parkedOpenCommand(entry);
	return {
		...command,
		...(command.provider === undefined && command.modelId === undefined && recorded.provider !== undefined
			? { provider: recorded.provider, modelId: recorded.modelId }
			: {}),
		...(command.thinkingLevel === undefined && recorded.thinkingLevel !== undefined
			? { thinkingLevel: recorded.thinkingLevel }
			: {}),
		...(command.permissionPreset === undefined && recorded.permissionPreset !== undefined
			? { permissionPreset: recorded.permissionPreset }
			: {}),
	};
}
