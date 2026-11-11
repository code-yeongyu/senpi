/**
 * Parses a `move_session` request into one op with its typed fields, or the sentence that says what is wrong with it
 * (answered as `invalid_move_request`). Nothing here touches a file.
 */
import { isAbsolute } from "node:path";
import { isPlainId, parseMoveId } from "../../core/session-move/bundle.ts";
import type { InlineBundleFile } from "../../core/session-move/inline-bundle.ts";
import { type MoveAnswer, parseMoveStatus } from "../../core/session-move/move-ledger.ts";
import type { MoveId } from "../../core/session-move/ownership.ts";
import { MOVE_INLINE_MAX_BYTES, MOVE_INLINE_MAX_FILES } from "./session-move-wire.ts";

export type MoveRequest =
	| { readonly op: "prepare" | "cancel"; readonly moveId: MoveId }
	| { readonly op: "status"; readonly moveId: MoveId; readonly sessionPath: string | undefined }
	| {
			readonly op: "export";
			readonly sessionPath: string;
			readonly moveId: MoveId;
			readonly target: string;
			readonly dropped: readonly string[];
			/** The most bytes the bundle may hold to be answered inline; `undefined` when the caller did not ask. */
			readonly inlineMaxBytes: number | undefined;
	  }
	| {
			readonly op: "import";
			readonly bundle: { readonly dir: string } | { readonly files: readonly InlineBundleFile[] };
			readonly cwd: string;
			readonly from: string;
			readonly sessionDir: string | undefined;
	  }
	| { readonly op: "finish"; readonly sessionPath: string; readonly moveId: MoveId; readonly answer: MoveAnswer }
	| { readonly op: "revoke"; readonly sessionPath: string; readonly moveId: MoveId }
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Padded base64, as `Buffer.toString("base64")` writes it: a length that is a multiple of four, alphabet characters,
 * then at most two `=`. One character class and no repeated group, so a string as long as a line costs one pass.
 */
const BASE64_CHARACTERS = /^[A-Za-z0-9+/]*={0,2}$/;
const isPaddedBase64 = (value: string): boolean => value.length % 4 === 0 && BASE64_CHARACTERS.test(value);

function parseInlineFiles(value: unknown): readonly InlineBundleFile[] | string {
	if (!Array.isArray(value) || value.length > MOVE_INLINE_MAX_FILES)
		return `files must be a list of at most ${MOVE_INLINE_MAX_FILES} { path, sha256, base64 } entries.`;
	const files: InlineBundleFile[] = [];
	let bytes = 0;
	for (const item of value) {
		if (!isRecord(item)) return "each file must be an object with path, sha256 and base64.";
		const { path, sha256, base64 } = item;
		if (typeof path !== "string" || typeof sha256 !== "string" || typeof base64 !== "string")
			return "each file needs path and sha256 as strings and base64 as padded base64.";
		// Counted from the length, before a character is read, so files over the cap are refused at no further cost.
		bytes += Buffer.byteLength(base64, "base64");
		if (bytes > MOVE_INLINE_MAX_BYTES)
			return `files hold more than the ${MOVE_INLINE_MAX_BYTES} bytes an inline import takes; send the bundle folder instead.`;
		if (!isPaddedBase64(base64)) return "each file needs path and sha256 as strings and base64 as padded base64.";
		files.push({ path, sha256, base64 });
	}
	return files;
}

/** The import names the session file itself, so these `open_session` fields are not the caller's to set. */
const OPEN_FIELDS_THE_IMPORT_SETS = ["id", "type", "sessionPath", "cwd", "admissionId"];

function importBundle(
	raw: Record<string, unknown>,
): { readonly dir: string } | { readonly files: readonly InlineBundleFile[] } | string {
	if (raw.files === undefined) {
		if (!text(raw.bundleDir) || !text(raw.cwd) || !isAbsolute(raw.bundleDir) || !isAbsolute(raw.cwd))
			return "import needs bundleDir and cwd as absolute paths.";
		return { dir: raw.bundleDir };
	}
	if (raw.bundleDir !== undefined) return "import takes bundleDir or files, not both.";
	const files = parseInlineFiles(raw.files);
	return typeof files === "string" ? files : { files };
}

function parseImport(raw: Record<string, unknown>): MoveRequest | string {
	const bundle = importBundle(raw);
	if (typeof bundle === "string") return bundle;
	if (!text(raw.cwd) || !isAbsolute(raw.cwd)) return "import with files needs cwd as an absolute path.";
	const from = typeof raw.from === "string" ? raw.from : undefined;
	if (raw.from !== undefined && from === undefined) return "from must be a string.";
	if (raw.sessionDir !== undefined && (!text(raw.sessionDir) || !isAbsolute(raw.sessionDir)))
		return "sessionDir must be an absolute path.";
	const { open } = raw;
	if (
		open !== undefined &&
		open !== true &&
		!(isRecord(open) && OPEN_FIELDS_THE_IMPORT_SETS.every((field) => !(field in open)))
	)
		return "open must be true or open_session fields other than id, type, sessionPath, cwd and admissionId.";
	return { op: "import", bundle, cwd: raw.cwd, from: from ?? "", sessionDir: raw.sessionDir };
}

export function parseMoveRequest(raw: Record<string, unknown>): MoveRequest | string {
	const { op } = raw;
	if (op === "import") return parseImport(raw);
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
			if (raw.inline !== undefined && raw.inline !== true) return "inline must be true or omitted.";
			const cap = raw.inlineMaxBytes ?? MOVE_INLINE_MAX_BYTES;
			if (typeof cap !== "number" || !Number.isSafeInteger(cap) || cap < 0)
				return "inlineMaxBytes must be a non-negative integer.";
			const inlineMaxBytes = raw.inline === true ? Math.min(cap, MOVE_INLINE_MAX_BYTES) : undefined;
			return { op, sessionPath: raw.sessionPath, moveId: id, target: raw.target, dropped, inlineMaxBytes };
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
		default:
			return 'op must be one of "prepare", "cancel", "status", "export", "import", "finish", "revoke" or "copy".';
	}
}
