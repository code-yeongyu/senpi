/**
 * `move_session`: the RPC face of the engine's session move (senpi#3676). Each op is one call into
 * `core/session-move/`; this file only parses the request, picks this host's folders (the move ledger, the kept
 * outgoing bundles and the session folder for a working directory) and maps refusals to wire codes.
 */
import { join } from "node:path";
import { readRepositoryIdentity } from "../../core/repository-identity.ts";
import { getDefaultSessionDir, loadEntriesFromFileAsync } from "../../core/session-manager.ts";
import { copySessionAs } from "../../core/session-move/copy.ts";
import { exportSessionForMoveAndRead } from "../../core/session-move/export.ts";
import { sealedOutgoingStateDir } from "../../core/session-move/extension-state.ts";
import { finishMove } from "../../core/session-move/finish.ts";
import { readSessionRepositoryIdentity } from "../../core/session-move/identity.ts";
import { readInlineBundle } from "../../core/session-move/inline-bundle.ts";
import { MoveLedger, type MoveRecord } from "../../core/session-move/move-ledger.ts";
import { type MoveId, sessionOwnership } from "../../core/session-move/ownership.ts";
import { prepareMove } from "../../core/session-move/prepare.ts";
import { revokeImportedMove } from "../../core/session-move/revoke.ts";
import { orderedRealPath, realSessionPath } from "../../core/session-move/session-lock.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { landedWhenFenced, statusAnswer } from "./session-move-landed.ts";
import {
	MOVE_INLINE_MAX_FILES,
	RPC_ERROR_INVALID_MOVE_REQUEST,
	RPC_ERROR_MOVE_FAILED,
	RPC_ERROR_MOVE_NOT_RELEASED,
	RPC_ERROR_SESSION_OPEN_HERE,
	type RpcMoveLanded,
	type RpcMoveRecord,
	type RpcMoveSessionCommand,
	type RpcMoveSessionData,
} from "./session-move-wire.ts";
import { importMoved, type MoveImportPort, openLanded, sessionDirRefusal } from "./session-move-import.ts";
import { type MoveRequest, parseMoveRequest } from "./session-move-request.ts";

export interface MoveSessionPort extends MoveImportPort {
	hostedPaths(): readonly string[];
}

/** Refusal codes the move core throws (`error.code`), passed through to the wire as they are. */
const CORE_CODES: ReadonlySet<string> = new Set([
	"move_fenced",
	"move_bundle_invalid",
	"move_repository_mismatch",
	"move_target_occupied",
	"move_mismatch",
	"move_already_moved",
	"session_moved_away",
	"invalid_move_request",
]);

/** Core error codes whose wire name differs. */
const RENAMED_CODES: Readonly<Record<string, string>> = { ESESSIONHELD: "session_held" };

const wireRecord = (record: MoveRecord): RpcMoveRecord =>
	record.state === "ready" ? { state: "ready", expires_at: record.expiresAt } : record;

export async function moveSession(
	port: MoveSessionPort,
	command: RpcMoveSessionCommand,
): Promise<RpcResponse | undefined> {
	const raw: Record<string, unknown> = { ...command };
	const parsed = parseMoveRequest(raw);
	if (typeof parsed === "string") return refusal(command.id, RPC_ERROR_INVALID_MOVE_REQUEST, parsed);
	const root = join(port.agentDir, "session-moves");
	const ledger = new MoveLedger(join(root, "ledger"));
	try {
		if (parsed.op !== "import") return answer(command.id, await run(parsed, port, ledger, root));
		const notAFolder = await sessionDirRefusal(parsed.sessionDir);
		if (notAFolder !== undefined) return refusal(command.id, RPC_ERROR_INVALID_MOVE_REQUEST, notAFolder);
		const landed = await importMoved(parsed, port, ledger, root);
		const open = command.op === "import" ? command.open : undefined;
		if (open === undefined) return answer(command.id, landed);
		const open_error = await openLanded(port, command.id, open, parsed.cwd, landed);
		return open_error === undefined ? undefined : answer(command.id, { ...landed, open_error });
	} catch (cause) {
		if (cause instanceof MoveRefusal) return refusal(command.id, cause.code, cause.message);
		const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
		const detail = cause instanceof Error ? cause.message : String(cause);
		return refusal(
			command.id,
			typeof code === "string"
				? (RENAMED_CODES[code] ?? (CORE_CODES.has(code) ? code : RPC_ERROR_MOVE_FAILED))
				: RPC_ERROR_MOVE_FAILED,
			detail,
			await landedWhenFenced(ledger, cause),
		);
	}
}

async function run(
	parsed: Exclude<MoveRequest, { op: "import" }>,
	port: MoveSessionPort,
	ledger: MoveLedger,
	root: string,
): Promise<RpcMoveSessionData | { readonly refuse: string; readonly detail: string }> {
	const outgoing = (moveId: MoveId) => join(root, "outgoing", moveId);
	switch (parsed.op) {
		case "prepare":
			return wireRecord(
				await prepareMove({
					ledger,
					moveId: parsed.moveId,
					cwd: parsed.cwd,
					repository: parsed.repository,
				}),
			);
		case "identity": {
			// The folder form reads what the import reads; the session form reads only this host's own session files.
			const repository =
				"cwd" in parsed
					? await readRepositoryIdentity(resolvePath(parsed.cwd))
					: await readSessionRepositoryIdentity(join(port.agentDir, "sessions"), parsed.sessionPath);
			// The answer is the wire shape: a plain copy, never the core object.
			return repository === undefined
				? {}
				: { repository: { ...repository, rootCommits: [...repository.rootCommits] } };
		}
		case "cancel":
			return wireRecord(await ledger.decline(parsed.moveId, "cancelled"));
		case "status":
			return statusAnswer(ledger, parsed.moveId, parsed.sessionPath);
		case "export": {
			const sessionFile = await orderedRealPath(parsed.sessionPath);
			const bundleDir = outgoing(parsed.moveId);
			const { inlineMaxBytes } = parsed;
			const { manifest, read: inline } = await exportSessionForMoveAndRead(
				{
					sessionFile,
					moveId: parsed.moveId,
					target: parsed.target,
					droppedUserMessages: parsed.dropped,
					bundleDir,
					extensionStateDir: () => sealedOutgoingStateDir(sessionFile, parsed.moveId),
					guard: async () => {
						await refuseOpenHere(
							port,
							sessionFile,
							"This session is open on this host. Release it with release_session reason move and this moveId first.",
						);
						await refuseUnlessSealedFor(sessionFile, parsed.moveId);
					},
					// Again inside the cross-process lock: a finish from another generation may have reclaimed it meanwhile.
					lockedGuard: () => refuseUnlessSealedFor(sessionFile, parsed.moveId),
				},
				async (written) =>
					inlineMaxBytes === undefined
						? undefined
						: readInlineBundle(written, { maxBytes: inlineMaxBytes, maxFiles: MOVE_INLINE_MAX_FILES }),
			);
			return {
				move_id: manifest.moveId,
				session_id: manifest.sessionId,
				bundle_dir: bundleDir,
				files: 1 + manifest.sidecars.length,
				...(inline === undefined ? {} : { inline_files: inline }),
			};
		}
		case "finish": {
			const sessionFile = await orderedRealPath(parsed.sessionPath);
			await finishMove({
				sessionFile,
				bundleDir: outgoing(parsed.moveId),
				moveId: parsed.moveId,
				answer: parsed.answer,
				guard: () =>
					refuseOpenHere(
						port,
						sessionFile,
						"This session is open on this host, so its runtime would not see the move end. Close it here, then finish the move.",
					),
			});
			return ownershipOf(sessionFile);
		}
		case "revoke": {
			const sessionFile = await orderedRealPath(parsed.sessionPath);
			await revokeImportedMove({
				sessionFile,
				moveId: parsed.moveId,
				ledger,
				guard: () =>
					refuseOpenHere(
						port,
						sessionFile,
						"This session is open on this host, so its runtime would not see the revoke. Close it here, then revoke the move.",
					),
			});
			return ownershipOf(sessionFile);
		}
		case "copy":
			return copySessionAs({
				sourceFile: await orderedRealPath(parsed.sessionPath),
				sessionId: parsed.sessionId,
				sessionDir: (cwd) =>
					parsed.sessionDir === undefined
						? getDefaultSessionDir(cwd, port.agentDir)
						: normalizePath(parsed.sessionDir),
			});
	}
}

async function ownershipOf(sessionFile: string): Promise<{ readonly ownership: "writable" | "moving" | "moved" }> {
	const ownership = sessionOwnership(await loadEntriesFromFileAsync(sessionFile));
	return { ownership: ownership.writable ? "writable" : ownership.state };
}

class MoveRefusal extends Error {
	readonly code: string;
	constructor(code: string, detail: string) {
		super(detail);
		this.name = "MoveRefusal";
		this.code = code;
	}
}

async function refuseUnlessSealedFor(sessionFile: string, moveId: MoveId): Promise<void> {
	const ownership = sessionOwnership(await loadEntriesFromFileAsync(sessionFile));
	if (ownership.writable || ownership.state !== "moving" || ownership.moveId !== moveId)
		throw new MoveRefusal(
			RPC_ERROR_MOVE_NOT_RELEASED,
			"This session file is not sealed for this move. Release it with release_session reason move and this moveId first; that also hands back its queued input.",
		);
}

async function refuseOpenHere(port: MoveSessionPort, sessionFile: string, detail: string): Promise<void> {
	const hosted = await Promise.all(port.hostedPaths().map((path) => realSessionPath(path)));
	if (hosted.includes(sessionFile)) throw new MoveRefusal(RPC_ERROR_SESSION_OPEN_HERE, detail);
}

function answer(id: string | undefined, data: Awaited<ReturnType<typeof run>>): RpcResponse {
	if ("refuse" in data) return refusal(id, data.refuse, data.detail);
	return { id, type: "response", command: "move_session", success: true, data };
}

function refusal(
	id: string | undefined,
	code: string,
	detail: string,
	landed?: RpcMoveLanded & { revoked?: true },
): RpcResponse {
	return {
		id,
		type: "response",
		command: "move_session",
		success: false,
		error: code,
		errorCode: code,
		errorData: { detail, ...landed },
	};
}
