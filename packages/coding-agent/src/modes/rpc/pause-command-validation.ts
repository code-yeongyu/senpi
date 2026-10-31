/** Field checks for the senpi#3811 pause commands, kept out of the shared validator to bound its size. */
type Command = Record<string, unknown>;

const nonEmpty = (value: unknown, max = 256): boolean =>
	typeof value === "string" && value.length > 0 && value.length <= max;
const seq = (value: unknown): boolean => typeof value === "number" && Number.isInteger(value) && value >= 0;
const RUN_REF_KINDS = new Set(["dag", "task", "workpool", "team"]);

function validRunRef(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const ref = value as Command;
	return typeof ref.kind === "string" && RUN_REF_KINDS.has(ref.kind) && nonEmpty(ref.id);
}

export function validatePauseCommand(value: Command): string | undefined {
	if ((value.type === "abort" || value.type === "interrupt") && value.intent !== undefined) {
		if (value.intent !== "stop" && value.intent !== "abort") return 'intent must be "stop" or "abort".';
	}
	if (value.type === "resume_session") {
		if (value.expectedSeq !== undefined && !seq(value.expectedSeq))
			return "expectedSeq must be a non-negative integer.";
		if (value.mode !== undefined && value.mode !== "continue" && value.mode !== "release")
			return 'mode must be "continue" or "release".';
		if (value.message !== undefined && typeof value.message !== "string") return "message must be a string.";
		if (value.effectId !== undefined && !nonEmpty(value.effectId)) return "effectId must be 1-256 characters.";
	}
	if (value.type === "hold_input") {
		if (!nonEmpty(value.inputId) || !seq(value.revision) || typeof value.text !== "string")
			return "hold_input needs inputId (1-256 chars), a non-negative integer revision, and text.";
		if (value.parentSessionId !== undefined && !nonEmpty(value.parentSessionId))
			return "parentSessionId must be 1-256 characters.";
		if (value.origin !== undefined && value.origin !== "human") return 'origin must be "human".';
	}
	if (value.type === "withdraw_held_input" && !nonEmpty(value.inputId)) return "withdraw_held_input needs inputId.";
	if (value.type === "pause_for_run") {
		if (!nonEmpty(value.parentSessionId) || !seq(value.parentPauseSeq) || !validRunRef(value.runRef))
			return "pause_for_run needs parentSessionId, a non-negative integer parentPauseSeq, and runRef { kind, id }.";
	}
	if (value.type === "resume_for_run") {
		if (
			!nonEmpty(value.parentSessionId) ||
			!seq(value.parentPauseSeq) ||
			!nonEmpty(value.resumeId) ||
			!seq(value.childSeqCutoff)
		)
			return "resume_for_run needs parentSessionId, parentPauseSeq, resumeId, and childSeqCutoff.";
	}
	return undefined;
}
