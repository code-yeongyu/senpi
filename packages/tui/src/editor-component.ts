import type { AutocompleteProvider } from "./autocomplete.ts";
import type { EditorImageState } from "./image-markers.ts";
import type { EditorPasteState } from "./paste-markers.ts";
import type { Component } from "./tui.ts";

/**
 * Interface for custom editor components.
 *
 * This allows extensions to provide their own editor implementation
 * (e.g., vim mode, emacs mode, custom keybindings) while maintaining
 * compatibility with the core application.
 */
export interface EditorComponent extends Component {
	// =========================================================================
	// Core text access (required)
	// =========================================================================

	/** Get the current text content */
	getText(): string;

	/** Set the text content */
	setText(text: string): void;

	/** Handle raw terminal input (key presses, paste sequences, etc.) */
	handleInput(data: string): void;

	// =========================================================================
	// Callbacks (required)
	// =========================================================================

	/** Called when user submits (e.g., Enter key) */
	onSubmit?: (text: string) => void;

	/** Called when text changes */
	onChange?: (text: string) => void;

	// =========================================================================
	// History support (optional)
	// =========================================================================

	/** Add text to history for up/down navigation */
	addToHistory?(text: string): void;

	// =========================================================================
	// Advanced text manipulation (optional)
	// =========================================================================

	/** Insert text at current cursor position */
	insertTextAtCursor?(text: string): void;

	/**
	 * Get text with any markers expanded (e.g., paste markers).
	 * Falls back to getText() if not implemented.
	 */
	getExpandedText?(): string;

	/**
	 * Snapshot the paste-marker registry so collapsed markers can be
	 * transferred to another editor instance alongside getText().
	 *
	 * Paired contract: implement getPasteState and setPasteState together.
	 * Callers only hand collapsed markers to an editor that can export them
	 * again; an editor implementing setPasteState without getPasteState is
	 * treated as paste-unaware and receives expanded text instead.
	 */
	getPasteState?(): EditorPasteState;

	/**
	 * Install a paste-marker registry snapshot taken from another editor
	 * instance. Called after setText() with that editor's raw (marker) text.
	 * Paired contract: implement together with getPasteState (see above).
	 * When not implemented, callers must transfer the expanded text instead.
	 */
	setPasteState?(state: EditorPasteState): void;

	// =========================================================================
	// Image markers (optional)
	// =========================================================================

	/**
	 * Insert the next atomic `[Image #N]` marker at the cursor and return its id.
	 * The editor stores ids only; the caller keeps the image payload keyed by id.
	 *
	 * The returned id is the marker's FINAL canonical number - its 1-based
	 * reading position after the editor renumbers the visible markers to stay
	 * 1..k in reading order - and `onImageMarkersChanged` fires (with the
	 * PRE-renumber ids) before the id is returned, so the caller registering its
	 * payload under the returned id immediately after the call always lands on
	 * a vacant slot.
	 *
	 * Paired contract: implement insertImageMarker together with
	 * onImageMarkersChanged. Callers must be told when markers are removed or
	 * renumbered, otherwise their payload map desynchronizes from the visible
	 * numbers; an editor exposing insertImageMarker without the callback is
	 * treated as image-unaware and receives the plain text path instead.
	 */
	insertImageMarker?(): number;

	/**
	 * Snapshot the image-marker registry (ids only, never image bytes) so markers
	 * can be transferred to another editor instance alongside getText().
	 *
	 * Paired contract: implement getImageMarkerState and setImageMarkerState
	 * together. Callers only hand markers to an editor that can export them
	 * again; an editor implementing setImageMarkerState without
	 * getImageMarkerState is treated as marker-unaware and its markers are
	 * dropped on transfer.
	 */
	getImageMarkerState?(): EditorImageState;

	/**
	 * Install an image-marker registry snapshot taken from another editor
	 * instance. Called after setText() with that editor's raw (marker) text.
	 * Paired contract: implement together with getImageMarkerState (see above).
	 */
	setImageMarkerState?(state: EditorImageState): void;

	/**
	 * Called with the image-marker ids in text reading order whenever markers are
	 * added, removed, pruned or renumbered.
	 *
	 * The reported ids are the keys the caller currently keys its payloads by
	 * (the PRE-renumber ids), and after every change the visible numbers are
	 * canonical 1..k in reading order, so the caller re-keys payload
	 * `order[i]` onto slot `i + 1`.
	 *
	 * Paired contract: required whenever insertImageMarker is implemented (see
	 * above) - the reported order is the only signal that keeps the caller's
	 * payload map aligned with the displayed `[Image #N]` numbers.
	 */
	onImageMarkersChanged?: (order: number[]) => void;

	/**
	 * Snapshot the attachment payloads keyed by marker id so the editor's undo
	 * stack can restore them together with the marker text and registry ids.
	 * The editor stores the returned value opaquely; return `undefined` to store
	 * nothing.
	 *
	 * Paired contract: implement together with restoreAttachmentState. Without
	 * these hooks an undo that revives a deleted marker displays it with no (or
	 * the wrong) payload behind it, because the delete re-keyed the survivors.
	 */
	snapshotAttachmentState?: () => unknown;

	/**
	 * Restore the attachment payloads captured by {@link snapshotAttachmentState}
	 * when the editor's undo pops the matching snapshot. Called before
	 * `onImageMarkersChanged` fires for that undo.
	 *
	 * Paired contract: implement together with snapshotAttachmentState.
	 */
	restoreAttachmentState?: (state: unknown) => void;

	// =========================================================================
	// Autocomplete support (optional)
	// =========================================================================

	/** Set the autocomplete provider */
	setAutocompleteProvider?(provider: AutocompleteProvider): void;

	// =========================================================================
	// Appearance (optional)
	// =========================================================================

	/** Border color function */
	borderColor?: (str: string) => string;

	/** Set horizontal padding */
	setPaddingX?(padding: number): void;

	/** Set max visible items in autocomplete dropdown */
	setAutocompleteMaxVisible?(maxVisible: number): void;
}
