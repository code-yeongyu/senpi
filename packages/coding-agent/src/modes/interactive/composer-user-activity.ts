import type { EditorComponent } from "@earendil-works/pi-tui";

const unobservedInput = new WeakMap<EditorComponent, (data: string) => void>();

/** Extension-supplied text updates the composer but is not terminal input. */
export function insertProgrammaticComposerInput(editor: EditorComponent, data: string): void {
	const handleInput = unobservedInput.get(editor) ?? editor.handleInput.bind(editor);
	handleInput(data);
}

/** Observe user edits, not setText calls that restore drafts during resume/reload. */
export function observeComposerActivity(editor: EditorComponent, onActivity: () => void): void {
	const handleInput = editor.handleInput.bind(editor);
	unobservedInput.set(editor, handleInput);
	editor.handleInput = (data) => {
		const previousText = editor.getText();
		const onSubmit = editor.onSubmit;
		let submitted = false;
		editor.onSubmit = (...args) => {
			submitted = true;
			onSubmit?.(...args);
		};
		try {
			handleInput(data);
			// Submission clears the editor and is handled by prompt admission instead.
			if (!submitted && editor.getText() !== previousText) onActivity();
		} finally {
			editor.onSubmit = onSubmit;
		}
	};
}
