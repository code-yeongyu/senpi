/** One shell line as the line editor (readline, emacs mode) holds it, and how it was built. */
export interface LineDraft {
	/** The line the editor holds, exact while every key used is one the guard models. */
	readonly text: string;
	readonly cursor: number;
	/** The line as if every printable byte and tab were appended at the end. */
	readonly appendOnly: string;
	/** Every printable byte typed since the line started or was last discarded (ctrl+u, ctrl+c), in order. */
	readonly typed: string;
	/** Text a yank put on the line. */
	readonly yanked: readonly string[];
	/** A key other than a printable append, backspace, ctrl+u or ctrl+c reached the line. */
	readonly edited: boolean;
	/** A key the guard does not model reached the line (tab completion, a meta key, an unknown escape). */
	readonly unfollowed: boolean;
	/** One of those keys may have recalled an earlier line (history keys, meta keys, unknown escapes). */
	readonly recalled: boolean;
}

/** A background shell's line editor between `bash_input` calls. */
export interface EditorState {
	readonly line: LineDraft;
	/** Killed text, newest last; readline yanks the newest. */
	readonly killRing: readonly string[];
	/** The last key was a kill, so the next kill joins the same ring entry, as readline does. */
	readonly killing: boolean;
}

const RING_SIZE = 10;

export const EMPTY_LINE: LineDraft = {
	text: "",
	cursor: 0,
	appendOnly: "",
	typed: "",
	yanked: [],
	edited: false,
	unfollowed: false,
	recalled: false,
};

export const FRESH_EDITOR: EditorState = { line: EMPTY_LINE, killRing: [], killing: false };

const isSpace = (char: string | undefined) => char !== undefined && /\s/.test(char);

/** Applies keys to an {@link EditorState}; the caller keeps the result only when the call is allowed. */
export class LineEditor {
	#line: LineDraft;
	#ring: string[];
	#killing: boolean;

	constructor(state: EditorState) {
		this.#line = state.line;
		this.#ring = [...state.killRing];
		this.#killing = state.killing;
	}

	get state(): EditorState {
		return { line: this.#line, killRing: [...this.#ring], killing: this.#killing };
	}

	/** Enter: the line runs and a new empty one starts. */
	submit(): LineDraft {
		const line = this.#line;
		this.#line = EMPTY_LINE;
		this.#killing = false;
		return line;
	}

	insert(text: string): void {
		const { text: line, cursor } = this.#line;
		this.#set({
			text: line.slice(0, cursor) + text + line.slice(cursor),
			cursor: cursor + text.length,
			appendOnly: this.#line.appendOnly + text,
			typed: this.#line.typed + text,
		});
	}

	backspace(): void {
		const { text, cursor } = this.#line;
		const at = Math.max(cursor - 1, 0);
		this.#set({
			text: text.slice(0, at) + text.slice(cursor),
			cursor: at,
			appendOnly: this.#line.appendOnly.slice(0, -1),
		});
	}

	/** ctrl+d on a non-empty line and the Delete key; ctrl+d on an empty line is end-of-file and runs nothing. */
	deleteForward(): void {
		const { text, cursor } = this.#line;
		this.#set({ text: text.slice(0, cursor) + text.slice(cursor + 1), edited: true });
	}

	moveTo(position: number): void {
		this.#set({ cursor: Math.min(Math.max(position, 0), this.#line.text.length), edited: true });
	}

	moveBy(delta: number): void {
		this.moveTo(this.#line.cursor + delta);
	}

	/** ctrl+c: the line is dropped; the kill ring is untouched. */
	discard(): void {
		this.#line = EMPTY_LINE;
		this.#killing = false;
	}

	/** ctrl+u: kills from the start of the line to the cursor. */
	killToStart(): void {
		const { text, cursor } = this.#line;
		this.#kill(text.slice(0, cursor), "backward");
		this.#line = { ...this.#line, text: text.slice(cursor), cursor: 0, appendOnly: "", typed: "" };
	}

	/** ctrl+k: kills from the cursor to the end of the line. */
	killToEnd(): void {
		const { text, cursor } = this.#line;
		this.#kill(text.slice(cursor), "forward");
		this.#line = { ...this.#line, text: text.slice(0, cursor), edited: true };
	}

	/** ctrl+w (unix-word-rubout): kills back to the previous whitespace. */
	killWordBackward(): void {
		const { text, cursor } = this.#line;
		let start = cursor;
		while (start > 0 && isSpace(text[start - 1])) start -= 1;
		while (start > 0 && !isSpace(text[start - 1])) start -= 1;
		this.#kill(text.slice(start, cursor), "backward");
		this.#line = { ...this.#line, text: text.slice(0, start) + text.slice(cursor), cursor: start, edited: true };
	}

	/** ctrl+y: inserts the newest killed text at the cursor. */
	yank(): void {
		const killed = this.#ring.at(-1) ?? "";
		const { text, cursor } = this.#line;
		this.#set({
			text: text.slice(0, cursor) + killed + text.slice(cursor),
			cursor: cursor + killed.length,
			yanked: [...this.#line.yanked, killed],
			edited: true,
		});
	}

	/** Keys with no effect on the line (ctrl+l redraws the screen). */
	ignore(): void {
		this.#killing = false;
	}

	/** A key the guard does not model; the line it leaves is no longer known. */
	unfollowed(recalled: boolean, appended = ""): void {
		this.#set({
			appendOnly: this.#line.appendOnly + appended,
			edited: true,
			unfollowed: true,
			recalled: this.#line.recalled || recalled,
		});
	}

	#set(edit: Partial<LineDraft>): void {
		this.#line = { ...this.#line, ...edit };
		this.#killing = false;
	}

	#kill(text: string, direction: "backward" | "forward"): void {
		const last = this.#ring.at(-1);
		if (this.#killing && last !== undefined) {
			this.#ring[this.#ring.length - 1] = direction === "backward" ? text + last : last + text;
		} else if (text !== "") {
			this.#ring.push(text);
			if (this.#ring.length > RING_SIZE) this.#ring.shift();
		}
		this.#killing = text !== "" || this.#killing;
	}
}
