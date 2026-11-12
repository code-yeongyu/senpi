/**
 * Whether a session an open loads stays when the opening connection ends, decided at line receipt (senpi#5808). A
 * delegated connection ends with the viewer it forwards for, while the forwarder keeps serving what it opened to the
 * next one: every open on it is retained, whatever it asks. On a machine-owned host an open that does not say is
 * retained. The rule covers every record that opens a session on its connection: `open_session`, `claim_session`, and
 * the open an `import` asks for with `open` (senpi#6267).
 */
import type { RpcCommand } from "./rpc-types.ts";

export function withOpenRetention(command: RpcCommand, delegated: boolean, machineOwned: boolean): RpcCommand {
	const retainedAgainst = (asked: unknown): boolean =>
		delegated ? asked !== true : machineOwned && asked === undefined;
	if (command.type === "open_session" || command.type === "claim_session")
		return retainedAgainst(command.retain_on_disconnect) ? { ...command, retain_on_disconnect: true } : command;
	if (command.type !== "move_session" || command.op !== "import") return command;
	const { open } = command;
	// The line is not parsed yet: an `open` that is neither `true` nor an object is left for the import to refuse.
	const fields =
		open === true ? {} : typeof open === "object" && open !== null && !Array.isArray(open) ? open : undefined;
	return fields !== undefined && retainedAgainst(fields.retain_on_disconnect)
		? { ...command, open: { ...fields, retain_on_disconnect: true } }
		: command;
}
