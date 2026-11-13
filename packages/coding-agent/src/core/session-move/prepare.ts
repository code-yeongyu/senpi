/**
 * The receiver's readying step (senpi#6435). A move whose folder is not a checkout of the repository the session
 * recorded is refused HERE, before the sender releases anything, by the comparison the import makes. The folder is
 * kept on the move's record, so the import lands only where this step checked. A caller that names the session also
 * has its landing file looked at here (senpi#6471): one that is already taken refuses the move the same way.
 */
import { join } from "node:path";
import type { RepositoryIdentity } from "../repository-identity.ts";
import { landingFile, MoveTargetOccupiedError } from "./landing-occupied.ts";
import type { MoveLedger, MoveRecord } from "./move-ledger.ts";
import type { MoveId } from "./ownership.ts";
import { isCheckoutOfRepository, MoveRefusedError } from "./repository-check.ts";

export interface PrepareMoveOptions {
	readonly ledger: MoveLedger;
	readonly moveId: MoveId;
	/** The folder the move is to be imported into. Without it the move is readied exactly as it always was. */
	readonly cwd?: string;
	/** What the sender answered for the session (`identity`); absent is compared as "the session recorded none". */
	readonly repository?: RepositoryIdentity;
	/**
	 * The session the move brings and the session folder it lands in (senpi#6471). With them a landing file that is
	 * already taken is refused here, before the sender releases anything. Only read: the import replaces a predecessor.
	 */
	readonly landing?: { readonly sessionId: string; readonly sessionFileName: string; readonly sessionDir: string };
}

export async function prepareMove(options: PrepareMoveOptions): Promise<MoveRecord> {
	if (options.cwd === undefined) return options.ledger.prepare(options.moveId);
	if (!(await isCheckoutOfRepository(options.cwd, options.repository))) throw new MoveRefusedError(options.cwd);
	if (options.landing !== undefined) {
		const target = join(options.landing.sessionDir, options.landing.sessionFileName);
		if ((await landingFile(target, options.landing.sessionId)) === "occupied")
			throw new MoveTargetOccupiedError(target);
	}
	return options.ledger.prepare(options.moveId, options.cwd);
}
