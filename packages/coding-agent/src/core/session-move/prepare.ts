/**
 * The receiver's readying step (senpi#6435). A move whose folder is not a checkout of the repository the session
 * recorded is refused HERE, before the sender releases anything, by the comparison the import makes (a folder missing on
 * this device as `workspace_missing`). The folder is
 * kept on the move's record, so the import lands only where this step checked.
 */
import type { RepositoryIdentity } from "../repository-identity.ts";
import type { MoveLedger, MoveRecord } from "./move-ledger.ts";
import type { MoveId } from "./ownership.ts";
import { checkoutRefusal, checkoutVerdict } from "./repository-check.ts";

export interface PrepareMoveOptions {
	readonly ledger: MoveLedger;
	readonly moveId: MoveId;
	/** The folder the move is to be imported into. Without it the move is readied exactly as it always was. */
	readonly cwd?: string;
	/** What the sender answered for the session (`identity`); absent is compared as "the session recorded none". */
	readonly repository?: RepositoryIdentity;
}

export async function prepareMove(options: PrepareMoveOptions): Promise<MoveRecord> {
	if (options.cwd === undefined) return options.ledger.prepare(options.moveId);
	const verdict = await checkoutVerdict(options.cwd, options.repository);
	if (verdict !== "same") throw checkoutRefusal(verdict, options.cwd);
	return options.ledger.prepare(options.moveId, options.cwd);
}
