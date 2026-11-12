/**
 * `move_session`: the RPC face of the engine's session move (senpi#3676). Each op is one call into
 * `core/session-move/`; this file only parses the request, picks this host's folders (the move ledger, the kept
 * outgoing bundles and the session folder for a working directory) and maps refusals to wire codes.
 */
import { join } from "node:path";
import { getDefaultSessionDir, loadEntriesFromFileAsync } from "../../core/session-manager.ts";
import { copySessionAs } from "../../core/session-move/copy.ts";
import { exportSessionForMove } from "../../core/session-move/export.ts";
import { sealedOutgoingStateDir } from "../../core/session-move/extension-state.ts";
import { finishMove } from "../../core/session-move/finish.ts";
import { answerMoveStatus, importMovedSession } from "../../core/session-move/import.ts";
import { MoveLedger, type MoveRecord } from "../../core/session-move/move-ledger.ts";
import { headerSessionId, type MoveId, sessionOwnership } from "../../core/session-move/ownership.ts";
import { revokeImportedMove } from "../../core/session-move/revoke.ts";
import { orderedRealPath, realSessionPath } from "../../core/session-move/session-lock.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { RpcResponse } from "./rpc-types.ts";
import {
	RPC_ERROR_INVALID_MOVE_REQUEST,
	RPC_ERROR_MOVE_FAILED,
	RPC_ERROR_MOVE_NOT_RELEASED,
	RPC_ERROR_SESSION_OPEN_HERE,
	type RpcMoveRecord,
	type RpcMoveSessionCommand,
	type RpcMoveSessionData,
} from "./session-move-wire.ts";
import { type MoveRequest, parseMoveRequest } from "./session-move-request.ts";

export interface MoveSessionPort {
	/** This host's agent directory: the move folders live under `<agentDir>/session-moves`. */
	readonly agentDir: string;
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

export async function moveSession(port: MoveSessionPort, command: RpcMoveSessionCommand): Promise<RpcResponse> {
	const raw: Record<string, unknown> = { ...command };
	const parsed = parseMoveRequest(raw);
	if (typeof parsed === "string") return refusal(command.id, RPC_ERROR_INVALID_MOVE_REQUEST, parsed);
	const root = join(port.agentDir, "session-moves");
	const ledger = new MoveLedger(join(root, "ledger"));
	const outgoing = (moveId: MoveId) => join(root, "outgoing", moveId);
	try {
		return answer(command.id, await run(parsed, port, ledger, outgoing));
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
		);
	}
}

async function run(
	parsed: MoveRequest,
	port: MoveSessionPort,
	ledger: MoveLedger,
	outgoing: (moveId: MoveId) => string,
): Promise<RpcMoveSessionData | { readonly refuse: string; readonly detail: string }> {
	switch (parsed.op) {
		case "prepare":
			return wireRecord(await ledger.prepare(parsed.moveId));
		case "cancel":
			return wireRecord(await ledger.decline(parsed.moveId, "cancelled"));
		case "status":
			return answerMoveStatus(ledger, parsed.moveId, parsed.sessionPath);
		case "export": {
			const sessionFile = await orderedRealPath(parsed.sessionPath);
			const bundleDir = outgoing(parsed.moveId);
			const manifest = await exportSessionForMove({
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
			});
			return {
				move_id: manifest.moveId,
				session_id: manifest.sessionId,
				bundle_dir: bundleDir,
				files: 1 + manifest.sidecars.length,
			};
		}
		case "import": {
			const cwd = resolvePath(parsed.cwd);
			const sessionDir = getDefaultSessionDir(cwd, port.agentDir);
			const { sessionFile } = await importMovedSession({
				bundleDir: normalizePath(parsed.bundleDir),
				targetCwd: cwd,
				ledger,
				sessionDir,
				from: parsed.from,
			});
			const sessionId = headerSessionId(await loadEntriesFromFileAsync(sessionFile));
			if (sessionId === undefined)
				throw new Error(`The imported session at ${sessionFile} has no id in its header.`);
			return { session_id: sessionId, session_path: sessionFile };
		}
		case "finish": {
			const sessionFile = await orderedRealPath(parsed.sessionPath);
			const settled = await finishMove({
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
			const ownership = await ownershipOf(sessionFile);
			return ownership.ownership === "writable" ? { ...ownership, held_this_move: settled.heldThisMove } : ownership;
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

function refusal(id: string | undefined, code: string, detail: string): RpcResponse {
	return {
		id,
		type: "response",
		command: "move_session",
		success: false,
		error: code,
		errorCode: code,
		errorData: { detail },
	};
}
