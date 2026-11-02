/**
 * Simple text input component for extensions.
 */

import { Container, type Focusable, getKeybindings, Input, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { armSecretInputDeadline } from "../../../core/extensions/secret-input.ts";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

export interface ExtensionInputOptions {
	secret?: boolean;
	deadlineAtMs?: number;
	tui?: TUI;
	timeout?: number;
	/** Text the input opens with; the cursor lands at its end. */
	initialValue?: string;
	description?: string;
}

export class ExtensionInputComponent extends Container implements Focusable {
	private input: Input;
	private onSubmitCallback: (value: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private secretTimer: (() => void) | undefined;
	readonly secret: boolean;

	// Focusable implementation - propagate to input for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	constructor(
		title: string,
		_placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: ExtensionInputOptions,
	) {
		super();
		this.secret = opts?.secret === true;

		this.onSubmitCallback = onSubmit;
		this.onCancelCallback = onCancel;
		this.baseTitle = title;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new Text(theme.fg("accent", title), 1, 0);
		this.addChild(this.titleText);
		if (opts?.description) {
			this.addChild(new Spacer(1));
			this.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}
		this.addChild(new Spacer(1));

		if (this.secret) {
			const deadline = opts?.deadlineAtMs ?? Date.now() + (opts?.timeout ?? 1800000);
			this.secretTimer = armSecretInputDeadline(deadline, () => this.onCancelCallback());
		} else if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", `${this.baseTitle} (${s}s)`)),
				() => this.onCancelCallback(),
			);
		}

		this.input = new Input({
			secret: this.secret,
			onInvalidInput: () =>
				this.titleText.setText(
					theme.fg("warning", "Secret input must be a single line without control characters."),
				),
		});
		if (this.secret) {
			this.input.onSubmit = (value) => this.onSubmitCallback(value);
			this.input.onEscape = () => this.onCancelCallback();
		}
		if (opts?.initialValue) {
			// Typed in, not assigned: Input.setValue() would leave the cursor at
			// column 0, ahead of the prefill the caller wants the user to edit.
			this.input.handleInput(opts.initialValue);
		}
		this.addChild(this.input);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(`${keyHint("tui.select.confirm", "submit")}  ${keyHint("tui.select.cancel", "cancel")}`, 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	handleInput(keyData: string): void {
		if (this.secret) {
			this.input.handleInput(keyData);
			return;
		}
		const kb = getKeybindings();
		if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			this.onSubmitCallback(this.input.getValue());
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.input.handleInput(keyData);
		}
	}

	dispose(): void {
		this.countdown?.dispose();
		this.secretTimer?.();
		if (this.secret) this.input.dispose();
		this.onSubmitCallback = () => {};
		this.onCancelCallback = () => {};
	}
}
