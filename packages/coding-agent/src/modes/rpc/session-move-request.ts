/**
 * Parses a `move_session` request into one op with its typed fields, or the sentence that says what is wrong with it
 * (answered as `invalid_move_request`). Nothing here touches a file.
 */
import { isAbsolute } from "node:path";
import { isPlainId, parseMoveId } from "../../core/session-move/bundle.ts";
import { type MoveAnswer, parseMoveStatus } from "../../core/session-move/move-ledger.ts";
import type { MoveId } from "../../core/session-move/ownership.ts";

export type MoveRequest =
	| { readonly op: "prepare" | "cancel"; readonly moveId: MoveId }
	| { readonly op: "status"; readonly moveId: MoveId; readonly sessionPath: string | undefined }
	| {
			readonly op: "export";
			readonly sessionPath: string;
			readonly moveId: MoveId;
			readonly target: string;
			readonly dropped: readonly string[];
	  }
	| { readonly op: "import"; readonly bundleDir: string; readonly cwd: string; readonly from: string }
	| { readonly op: "finish"; readonly sessionPath: string; readonly moveId: MoveId; readonly answer: MoveAnswer }
	| { readonly op: "revoke"; readonly sessionPath: string; readonly moveId: MoveId }
	| { readonly op: "ownership"; readonly sessionPath: string; readonly moveId: MoveId }
	| {
			readonly op: "copy";
			readonly sessionPath: string;
			readonly sessionId: string;
			readonly sessionDir: string | undefined;
	  };

function plainMoveId(value: unknown): MoveId | undefined {
	try {
		return parseMoveId(value);
	} catch {
		return undefined;
	}
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const PLAIN_ID_RULE = "a letter or digit, then letters, digits, '.', '_' or '-', at most 128 characters";

function parseCopy(raw: Record<string, unknown>): MoveRequest | string {
	if (!text(raw.sessionPath)) return "copy needs sessionPath, the session file to copy.";
	if (!isPlainId(raw.sessionId)) return `sessionId must be a plain id: ${PLAIN_ID_RULE}.`;
	if (raw.sessionDir !== undefined && (!text(raw.sessionDir) || !isAbsolute(raw.sessionDir)))
		return "sessionDir must be an absolute path.";
	return { op: "copy", sessionPath: raw.sessionPath, sessionId: raw.sessionId, sessionDir: raw.sessionDir };
}

export function parseMoveRequest(raw: Record<string, unknown>): MoveRequest | string {
	const { op } = raw;
	if (op === "import") {
		if (!text(raw.bundleDir) || !text(raw.cwd) || !isAbsolute(raw.bundleDir) || !isAbsolute(raw.cwd))
			return "import needs bundleDir and cwd as absolute paths.";
		const from = typeof raw.from === "string" ? raw.from : undefined;
		if (raw.from !== undefined && from === undefined) return "from must be a string.";
		return { op, bundleDir: raw.bundleDir, cwd: raw.cwd, from: from ?? "" };
	}
	if (op === "copy") return parseCopy(raw);
	const id = plainMoveId(raw.moveId);
	if (id === undefined) return `moveId must be a plain id: ${PLAIN_ID_RULE}.`;
	switch (op) {
		case "prepare":
		case "cancel":
			return { op, moveId: id };
		case "status": {
			const sessionPath = text(raw.sessionPath) ? raw.sessionPath : undefined;
			if (raw.sessionPath !== undefined && sessionPath === undefined)
				return "sessionPath must be a non-empty string.";
			return { op, moveId: id, sessionPath };
		}
		case "export": {
			const dropped = raw.droppedUserMessages ?? [];
			if (!text(raw.sessionPath) || !text(raw.target)) return "export needs sessionPath and target.";
			if (!Array.isArray(dropped) || !dropped.every((item): item is string => typeof item === "string"))
				return "droppedUserMessages must be the dropped.user_messages strings release_session returned.";
			return { op, sessionPath: raw.sessionPath, moveId: id, target: raw.target, dropped };
		}
		case "finish": {
			const answer = parseMoveStatus(raw.answer);
			if (!text(raw.sessionPath) || answer === undefined)
				return "finish needs sessionPath and the receiver's answer from status (receiving, accepted, declined or failed).";
			return { op, sessionPath: raw.sessionPath, moveId: id, answer };
		}
		case "revoke":
			if (!text(raw.sessionPath)) return "revoke needs sessionPath, the copy this host imported for the move.";
			return { op, sessionPath: raw.sessionPath, moveId: id };
		case "ownership":
			if (!text(raw.sessionPath)) return "ownership needs sessionPath, the session file to read.";
			return { op, sessionPath: raw.sessionPath, moveId: id };
		default:
			return 'op must be one of "prepare", "cancel", "status", "export", "import", "finish", "revoke", "ownership" or "copy".';
	}
}
