import { isAbsolute } from "node:path";
import { parseMoveId } from "../../core/session-move/bundle.ts";
import { type MoveStatus, parseMoveStatus } from "../../core/session-move/move-ledger.ts";
import type { MoveId } from "../../core/session-move/ownership.ts";

/** Parses a `move_session` request at the RPC boundary: an op, plain move ids, absolute paths, a known answer. */
export type Parsed =
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
	| { readonly op: "precheck"; readonly sessionPath: string }
	| { readonly op: "finish"; readonly sessionPath: string; readonly moveId: MoveId; readonly answer: MoveStatus };

function plainMoveId(value: unknown): MoveId | undefined {
	try {
		return parseMoveId(value);
	} catch {
		return undefined;
	}
}

const text = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

export function parseMoveRequest(raw: Record<string, unknown>): Parsed | string {
	const { op } = raw;
	if (op === "precheck") {
		if (!text(raw.sessionPath) || !isAbsolute(raw.sessionPath))
			return "precheck needs sessionPath as an absolute path.";
		return { op, sessionPath: raw.sessionPath };
	}
	if (op === "import") {
		if (!text(raw.bundleDir) || !text(raw.cwd) || !isAbsolute(raw.bundleDir) || !isAbsolute(raw.cwd))
			return "import needs bundleDir and cwd as absolute paths.";
		const from = typeof raw.from === "string" ? raw.from : undefined;
		if (raw.from !== undefined && from === undefined) return "from must be a string.";
		return { op, bundleDir: raw.bundleDir, cwd: raw.cwd, from: from ?? "" };
	}
	const id = plainMoveId(raw.moveId);
	if (id === undefined)
		return "moveId must be a plain id: a letter or digit, then letters, digits, '.', '_' or '-', at most 128 characters.";
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
		default:
			return 'op must be one of "prepare", "cancel", "status", "export", "import" or "finish".';
	}
}
