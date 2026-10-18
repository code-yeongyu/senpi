import type { EditorSubmitDetails } from "@earendil-works/pi-tui";
import { UnknownCommandError } from "../../core/unknown-command.ts";

/** A `/...` submission typed after leading whitespace is sent as text instead of checked as a command. */
export function submitsCommandAsText(text: string, details: EditorSubmitDetails | undefined): boolean {
	return text.startsWith("/") && details !== undefined && /^\s/.test(details.rawText);
}

export interface UnknownCommandFeedbackTarget {
	readonly editor: { getText(): string; setText(text: string): void };
	armConfirmation(text: string): void;
	readonly confirmHint: string;
	showWarning(message: string): void;
}

/**
 * Turn an unknown-command rejection into editor feedback: the submitted text goes back into an empty
 * editor, the rejection is shown with the confirm hint, and submitting the same text again sends it as
 * a message. Returns `false` for any other error.
 */
export function reportUnknownCommand(
	error: unknown,
	submittedText: string,
	target: UnknownCommandFeedbackTarget,
): boolean {
	if (!(error instanceof UnknownCommandError)) return false;
	if (target.editor.getText().trim() === "") target.editor.setText(submittedText);
	target.armConfirmation(submittedText);
	target.showWarning(`${error.message}\n${target.confirmHint}`);
	return true;
}
