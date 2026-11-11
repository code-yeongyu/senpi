/**
 * The export part of `release_session` reason `move` (senpi#6267): the request the release takes beside its own
 * fields, and the export it runs once the session is released, through the one function `move_session export` runs.
 *
 * The request is read before anything is interrupted, staged or sealed, so a request that cannot be met refuses the
 * release and changes nothing. The export itself runs after the release answered and cannot reject: the session is
 * sealed by then, and only the caller's give-back may undo that, so a failure is reported inside the successful
 * release answer and the caller raises it on the path that always gives back.
 */
import { parseMoveId } from "../../core/session-move/bundle.ts";
import { exportMoveBundle, type MoveExportPort, moveRefusalOf } from "./session-move-commands.ts";
import { isRecord, parseInlineRequest } from "./session-move-request.ts";
import type { RpcMoveSessionData } from "./session-move-wire.ts";

/** Capability: `release_session` reason `move` takes `export` and answers the export beside the release. */
export const RELEASE_SESSION_MOVE_EXPORT_CAPABILITY = "release_session_move_export";

/** What a release was asked to export, once its request is read. */
export type ReleaseExportAsk =
	| { readonly kind: "none" }
	| { readonly kind: "export"; readonly agentDir: string; readonly inlineMaxBytes: number | undefined }
	| { readonly kind: "invalid"; readonly detail: string };

export type ReleaseExportOutcome =
	| { readonly ok: true; readonly data: RpcMoveSessionData }
	| { readonly ok: false; readonly error: string; readonly detail: string };

/** The release's own answer, as the export it carries needs it. */
export interface ReleasedForExport {
	readonly sessionPath: string;
	readonly moveId: unknown;
	readonly target: string;
	readonly droppedUserMessages: readonly string[];
}

const invalid = (detail: string): ReleaseExportAsk => ({ kind: "invalid", detail });

/**
 * The `export` field of a `release_session`, read by the rule the `export` op reads its own fields by. `agentDir` is
 * the host's: a host that keeps none has nowhere to write the bundle.
 */
export function parseReleaseExport(raw: Record<string, unknown>, agentDir: string | undefined): ReleaseExportAsk {
	const asked = raw.export;
	if (asked === undefined) return { kind: "none" };
	if (raw.reason !== "move") return invalid("export is read only with reason move.");
	if (!isRecord(asked)) return invalid("export must be an object of the export fields: inline and inlineMaxBytes.");
	if (typeof raw.target !== "string" || raw.target.trim() === "")
		return invalid("a release that exports needs target, the device the move goes to.");
	if (agentDir === undefined) return invalid("this host keeps no agent directory to write a move bundle in.");
	const inline = parseInlineRequest(asked);
	return typeof inline === "string"
		? invalid(inline)
		: { kind: "export", agentDir, inlineMaxBytes: inline.inlineMaxBytes };
}

/**
 * Exports the session the release sealed. Every failure, the answer's own build included, becomes `ok: false` with
 * the code `move_session` would have answered: the release's own answer never changes.
 */
export async function exportForRelease(
	host: Pick<MoveExportPort, "hostedPaths">,
	ask: Extract<ReleaseExportAsk, { kind: "export" }>,
	released: ReleasedForExport,
): Promise<ReleaseExportOutcome> {
	try {
		const port: MoveExportPort = { agentDir: ask.agentDir, hostedPaths: () => host.hostedPaths() };
		const data = await exportMoveBundle(port, {
			op: "export",
			sessionPath: released.sessionPath,
			moveId: parseMoveId(released.moveId),
			target: released.target,
			dropped: released.droppedUserMessages,
			inlineMaxBytes: ask.inlineMaxBytes,
		});
		return { ok: true, data };
	} catch (cause) {
		// Never rethrown: a cause with no code of its own is reported as move_failed with its message.
		const { code, detail } = moveRefusalOf(cause instanceof Error ? cause : new Error(String(cause)));
		return { ok: false, error: code, detail };
	}
}
