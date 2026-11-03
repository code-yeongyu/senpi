import type { MoveRecord } from "./move-ledger.ts";

/** What the session file at a move's landing target records for the move. */
export type LandingOutcome = "absent" | "moved_in" | "revoked";

/** The hidden part of a move record: where the move lands, and whether its commit began. Never part of an answer. */
export interface Landing {
	readonly target?: string;
	readonly committing?: true;
}

export function parseLanding(value: unknown): Landing {
	if (typeof value !== "object" || value === null) return {};
	const { target, committing } = value as { target?: unknown; committing?: unknown };
	return {
		...(typeof target === "string" ? { target } : {}),
		...(committing === true ? { committing: true } : {}),
	};
}

/**
 * What a record becomes once the file at its target settles a step a crash interrupted: a committing record is
 * accepted (revoked if the file is) when its file landed and failed when it did not, and an accepted record whose file
 * is sealed gains its revoke mark. `undefined` when the record already agrees with the file.
 */
export function settledLanding(
	record: MoveRecord | undefined,
	committing: boolean,
	outcome: LandingOutcome,
): MoveRecord | undefined {
	if (record?.state === "receiving" && committing) {
		if (outcome === "absent") return { state: "failed", reason: "import_failed" };
		return outcome === "revoked" ? { state: "accepted", revoked: true } : { state: "accepted" };
	}
	if (record?.state === "accepted" && !("revoked" in record) && outcome === "revoked")
		return { state: "accepted", revoked: true };
	return undefined;
}

/** Whether an import into `target` may proceed: only a receiving move whose commit has not begun, into its target. */
export function landsAt(record: MoveRecord | undefined, landing: Landing, target: string): boolean {
	return record?.state === "receiving" && landing.committing !== true && landing.target === target;
}

export function landedElsewhere(record: MoveRecord | undefined, landing: Landing): string | undefined {
	const stored = landing.target;
	if (record?.state === "accepted" && "revoked" in record) return "it was revoked here and never lands again";
	if (record?.state === "receiving" && landing.committing === true)
		return "an import of it stopped mid-commit, and a move lands once; only the file it landed is accepted";
	if (record?.state === "accepted")
		return "it already landed here once, and a move lands once (a deleted copy is gone; copy the session to a new thread instead)";
	if (record?.state === "receiving" && stored === undefined)
		return "an older version started receiving it and where it landed is unknown; only its already landed file is accepted";
	return stored === undefined ? undefined : `it lands only as ${stored}`;
}
