/**
 * `move_session`: the RPC face of the engine's session move (senpi#3676). Each op is one call into
 * `core/session-move/`; this file only parses the request, picks this host's folders (the move ledger, the kept
 * outgoing bundles and the session folder for a working directory) and maps refusals to wire codes.
 */
import { join } from "node:path";
import { getDefaultSessionDir, loadEntriesFromFile } from "../../core/session-manager.ts";
import { exportSessionForMove } from "../../core/session-move/export.ts";
import { finishMove } from "../../core/session-move/finish.ts";
import { answerMoveStatus, importMovedSession } from "../../core/session-move/import.ts";
import { MoveLedger, type MoveRecord } from "../../core/session-move/move-ledger.ts";
import { headerSessionId, type MoveId, sessionOwnership } from "../../core/session-move/ownership.ts";
import { realSessionPath } from "../../core/session-move/session-lock.ts";
import { type ApplyResult, checkHeadOnRemote } from "../../core/session-move/working-tree.ts";
import { readSessionCwd } from "../../core/session-rebind.ts";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import type { RpcResponse } from "./rpc-types.ts";
import { type Parsed, parseMoveRequest } from "./session-move-request.ts";
import {
	RPC_ERROR_INVALID_MOVE_REQUEST,
	RPC_ERROR_MOVE_FAILED,
	RPC_ERROR_MOVE_NOT_RELEASED,
	RPC_ERROR_SESSION_OPEN_HERE,
	type RpcMoveRecord,
	type RpcMoveSessionCommand,
	type RpcMoveSessionData,
	type RpcWorkingTreeResult,
} from "./session-move-wire.ts";

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
	"session_moved_away",
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
	parsed: Parsed,
	port: MoveSessionPort,
	ledger: MoveLedger,
	outgoing: (moveId: MoveId) => string,
): Promise<RpcMoveSessionData | { readonly refuse: string; readonly detail: string }> {
	switch (parsed.op) {
		case "precheck": {
			const cwd = readSessionCwd(realSessionPath(parsed.sessionPath));
			if (cwd === undefined)
				return {
					refuse: RPC_ERROR_MOVE_FAILED,
					detail: "This session file records no working folder; it cannot be moved.",
				};
			const head = await checkHeadOnRemote(cwd);
			return head.ok ? { head: head.head } : { refuse: head.code, detail: head.detail };
		}
		case "prepare":
			return wireRecord(await ledger.prepare(parsed.moveId));
		case "cancel":
			return wireRecord(await ledger.decline(parsed.moveId, "cancelled"));
		case "status":
			return answerMoveStatus(ledger, parsed.moveId, parsed.sessionPath);
		case "export": {
			const sessionFile = realSessionPath(parsed.sessionPath);
			if (openHere(port, sessionFile))
				return {
					refuse: RPC_ERROR_SESSION_OPEN_HERE,
					detail:
						"This session is open on this host. Release it with release_session reason move and this moveId first.",
				};
			const ownership = sessionOwnership(loadEntriesFromFile(sessionFile));
			if (ownership.writable || ownership.state !== "moving" || ownership.moveId !== parsed.moveId)
				return {
					refuse: RPC_ERROR_MOVE_NOT_RELEASED,
					detail:
						"This session file is not sealed for this move. Release it with release_session reason move and this moveId first; that also hands back its queued input.",
				};
			const bundleDir = outgoing(parsed.moveId);
			const manifest = await exportSessionForMove({
				sessionFile,
				moveId: parsed.moveId,
				target: parsed.target,
				droppedUserMessages: parsed.dropped,
				workingTree: true,
				bundleDir,
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
			const { sessionFile, workingTree } = await importMovedSession({
				bundleDir: normalizePath(parsed.bundleDir),
				targetCwd: cwd,
				ledger,
				sessionDir,
				from: parsed.from,
			});
			const sessionId = headerSessionId(loadEntriesFromFile(sessionFile));
			if (sessionId === undefined)
				throw new Error(`The imported session at ${sessionFile} has no id in its header.`);
			return {
				session_id: sessionId,
				session_path: sessionFile,
				...(workingTree === undefined ? {} : { working_tree: wireTree(workingTree) }),
			};
		}
		case "finish": {
			const sessionFile = realSessionPath(parsed.sessionPath);
			if (openHere(port, sessionFile))
				return {
					refuse: RPC_ERROR_SESSION_OPEN_HERE,
					detail:
						"This session is open on this host, so its runtime would not see the move end. Close it here, then finish the move.",
				};
			await finishMove({
				sessionFile,
				bundleDir: outgoing(parsed.moveId),
				moveId: parsed.moveId,
				answer: parsed.answer,
			});
			const ownership = sessionOwnership(loadEntriesFromFile(sessionFile));
			return { ownership: ownership.writable ? "writable" : ownership.state };
		}
	}
}

function wireTree(result: ApplyResult): RpcWorkingTreeResult {
	return result.state === "kept"
		? { state: "kept", reason: result.reason, patch_file: result.patchFile, detail: result.detail }
		: { state: result.state };
}

function openHere(port: MoveSessionPort, sessionFile: string): boolean {
	return port.hostedPaths().some((path) => realSessionPath(path) === sessionFile);
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
