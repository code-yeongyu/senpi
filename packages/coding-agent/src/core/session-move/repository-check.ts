/**
 * The one comparison the target's `prepare` and the `import` both make (senpi#6435): is this folder a checkout of the
 * repository the session recorded? Two paths deciding it apart would refuse a move at one step and take it at the next.
 */
import { resolvePath } from "../../utils/paths.ts";
import {
	compareRepositoryIdentities,
	type RepositoryIdentity,
	readRepositoryIdentity,
} from "../repository-identity.ts";
import { pathExists } from "../tools/path-utils.ts";

export class MoveRefusedError extends Error {
	readonly code = "move_repository_mismatch";

	constructor(targetCwd: string, sourceCwd?: string) {
		super(
			`${targetCwd} is not the same repository the session was recorded in${sourceCwd === undefined ? "" : ` (${sourceCwd})`}. Pick a checkout of the same repository, or copy the session into this folder instead.`,
		);
		this.name = "MoveRefusedError";
	}
}

/**
 * A folder that does not exist on this device. It has no repository identity either, but it is
 * told apart from a mismatch: only this device can say which, and the client words the two differently.
 */
class MoveTargetMissingError extends Error {
	readonly code = "workspace_missing";

	constructor(targetCwd: string) {
		super(
			`${targetCwd} does not exist on this device. Clone the repository there, or pick a folder that holds it, then send the session again.`,
		);
		this.name = "MoveTargetMissingError";
	}
}

/** What the folder is to the session's repository: a checkout of it, missing on this device, or anything else. */
type CheckoutVerdict = "same" | "missing" | "other";

/** `cwd` is resolved the way the import resolves it, so both steps read the identity of the same folder. */
export async function checkoutVerdict(
	cwd: string,
	repository: RepositoryIdentity | undefined,
	read: (dir: string) => Promise<RepositoryIdentity | undefined> = readRepositoryIdentity,
): Promise<CheckoutVerdict> {
	const folder = resolvePath(cwd);
	if (compareRepositoryIdentities(repository, await read(folder)) === "same") return "same";
	return (await pathExists(folder)) ? "other" : "missing";
}

/** The refusal for a folder that is not a checkout of the session's repository. */
export const checkoutRefusal = (
	verdict: Exclude<CheckoutVerdict, "same">,
	targetCwd: string,
	sourceCwd?: string,
): MoveRefusedError | MoveTargetMissingError =>
	verdict === "missing" ? new MoveTargetMissingError(targetCwd) : new MoveRefusedError(targetCwd, sourceCwd);
