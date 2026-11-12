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

export class MoveRefusedError extends Error {
	readonly code = "move_repository_mismatch";

	constructor(targetCwd: string, sourceCwd?: string) {
		super(
			`${targetCwd} is not the same repository the session was recorded in${sourceCwd === undefined ? "" : ` (${sourceCwd})`}. Pick a checkout of the same repository, or copy the session into this folder instead.`,
		);
		this.name = "MoveRefusedError";
	}
}

/** `cwd` is resolved the way the import resolves it, so both steps read the identity of the same folder. */
export async function isCheckoutOfRepository(
	cwd: string,
	repository: RepositoryIdentity | undefined,
	read: (dir: string) => Promise<RepositoryIdentity | undefined> = readRepositoryIdentity,
): Promise<boolean> {
	return compareRepositoryIdentities(repository, await read(resolvePath(cwd))) === "same";
}
