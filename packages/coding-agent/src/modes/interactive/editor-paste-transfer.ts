import { type EditorComponent, expandPasteMarkers } from "@earendil-works/pi-tui";

/**
 * Local copy of pi-tui's image-marker pattern so this transfer never mutates
 * the shared /g regex's `lastIndex`.
 */
const IMAGE_MARKER_PATTERN = /\[Image #[1-9]\d*\]/g;

/**
 * Move the draft (and any collapsed markers) from one editor instance to
 * another. Returns whether the image markers survived the move: image payloads
 * live outside the editor, so the caller must drop them when the destination
 * cannot own the markers - a dead literal `[Image #N]` with a live attachment
 * behind it would misnumber every other attachment at submit.
 */
export function transferEditorContent(
	source: EditorComponent,
	target: EditorComponent,
): { imageMarkersTransferred: boolean } {
	const rawText = source.getText();
	const pasteState = source.getPasteState?.();
	const imageState = source.getImageMarkerState?.();
	const imageMarkersTransferred = Boolean(
		imageState && target.getImageMarkerState && target.setImageMarkerState && target.insertImageMarker,
	);
	if (pasteState && target.getPasteState && target.setPasteState) {
		target.setText(imageMarkersTransferred ? rawText : stripImageMarkers(rawText));
		target.setPasteState(pasteState);
	} else {
		const expanded = source.getExpandedText?.() ?? (pasteState ? expandPasteMarkers(rawText, pasteState) : rawText);
		target.setText(imageMarkersTransferred ? expanded : stripImageMarkers(expanded));
	}
	if (imageMarkersTransferred && imageState) target.setImageMarkerState?.(imageState);
	return { imageMarkersTransferred };
}

/** Removes every `[Image #N]` marker, collapsing the whitespace it leaves behind. */
function stripImageMarkers(text: string): string {
	return text
		.replace(IMAGE_MARKER_PATTERN, "")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
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
