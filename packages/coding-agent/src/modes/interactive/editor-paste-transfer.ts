import { type EditorComponent, expandPasteMarkers } from "@earendil-works/pi-tui";

export function transferEditorContent(source: EditorComponent, target: EditorComponent): void {
	const rawText = source.getText();
	const pasteState = source.getPasteState?.();
	if (pasteState && target.getPasteState && target.setPasteState) {
		target.setText(rawText);
		target.setPasteState(pasteState);
	} else {
		target.setText(source.getExpandedText?.() ?? (pasteState ? expandPasteMarkers(rawText, pasteState) : rawText));
	}
}

export function expandEditorSubmission(editor: EditorComponent, text: string): string {
	const pasteState = editor.getPasteState?.();
	return editor.getExpandedText?.() ?? (pasteState ? expandPasteMarkers(text, pasteState) : text);
}

/**
 * Expand a submitted editor value. Unlike {@link expandEditorSubmission},
 * which unconditionally prefers the live draft, this falls back to the
 * authoritative callback value when the editor has already cleared itself.
 * pi-tui's `Editor.submitValue()` clears the editor state and paste registry
 * before invoking `onSubmit`, so a post-clear `getExpandedText()` returns "".
 * Custom editors that submit before clearing still retain their non-empty
 * expanded value for backwards compatibility.
 */
export function expandSubmittedText(editor: EditorComponent, text: string): string {
	const liveExpandedText = editor.getExpandedText?.();
	if (liveExpandedText) return liveExpandedText;
	const pasteState = editor.getPasteState?.();
	return pasteState ? expandPasteMarkers(text, pasteState) : text;
}
