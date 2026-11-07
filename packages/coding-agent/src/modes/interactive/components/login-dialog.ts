import type { AuthInfoLink, OAuthDeviceCodeInfo } from "@earendil-works/pi-ai";
import { redactOAuthUrl } from "@earendil-works/pi-ai/utils/oauth-url";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	type TUI,
} from "@earendil-works/pi-tui";
import { openBrowser } from "../../../utils/open-browser.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint } from "./keybinding-hints.ts";

/**
 * Login dialog component - replaces editor during OAuth login flow
 */
export class LoginDialogComponent extends Container implements Focusable {
	private contentContainer: Container;
	private input: Input;
	private tui: TUI;
	private abortController = new AbortController();
	private inputResolver?: (value: string) => void;
	private inputRejecter?: (error: Error) => void;
	private liveHint?: Text;
	/**
	 * The prompt still waiting for input: the rows it showed above its input (spacer, message, placeholder) and its
	 * own hint, which a later waiting or info step may have replaced as the live hint.
	 */
	private openPrompt?: { readonly rows: readonly Component[]; readonly hint: Text };
	private onComplete: (success: boolean, message?: string) => void;

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
		tui: TUI,
		providerId: string,
		onComplete: (success: boolean, message?: string) => void,
		providerNameOverride?: string,
		titleOverride?: string,
	) {
		super();
		this.tui = tui;
		this.onComplete = onComplete;

		const providerName = providerNameOverride || providerId;
		const title = titleOverride ?? `Login to ${providerName}`;

		// Top border
		this.addChild(new DynamicBorder());

		// Title
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		// Dynamic content area
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		// Input (always present, used when needed)
		this.input = new Input();
		this.input.onSubmit = () => {
			if (this.inputResolver) {
				const value = this.input.getValue();
				this.replaceInputWithSubmittedText(value);
				this.inputResolver(value);
				this.inputResolver = undefined;
				this.inputRejecter = undefined;
				this.openPrompt = undefined;
			}
		};
		this.input.onEscape = () => {
			this.cancel();
		};

		// Bottom border
		this.addChild(new DynamicBorder());
	}

	get signal(): AbortSignal {
		return this.abortController.signal;
	}

	private replaceInputWithSubmittedText(value: string): void {
		this.contentContainer.children = this.contentContainer.children.map((child) =>
			child === this.input ? new Text(`> ${value}`, 0, 0) : child,
		);
	}

	/** Shows a prompt's rows, its input and its hint, and remembers them while it waits, for `replaceContent`. */
	private openPromptWith(rows: readonly Component[], hint: Text): void {
		for (const row of rows) this.contentContainer.addChild(row);
		this.remountInput(hint);
		this.openPrompt = { rows, hint };
	}

	/** The Input widget is a single instance; mounting it twice paints two live `>` rows. */
	private remountInput(hint: Text): void {
		this.contentContainer.children = this.contentContainer.children.filter(
			(child) => child !== this.input && child !== this.liveHint,
		);
		this.contentContainer.addChild(this.input);
		this.liveHint = hint;
		this.contentContainer.addChild(hint);
	}

	/**
	 * Exactly one `(to ...) ` hint row is ever live: a new one replaces the
	 * tracked previous hint wherever the input is NOT being remounted, so an
	 * interleaved wait/info step never leaves a stale hint beside the live one.
	 */
	private setLiveHint(hint: Text): void {
		this.contentContainer.children = this.contentContainer.children.filter((child) => child !== this.liveHint);
		this.liveHint = hint;
		this.contentContainer.addChild(hint);
	}

	/** Content that clears the dialog also drops any tracked live hint with it. */
	private resetContent(): void {
		this.contentContainer.clear();
		this.liveHint = undefined;
	}

	/**
	 * Starts a new step: clears the dialog, adds the step's rows, then puts back a prompt that is still waiting for
	 * input below them, with its input and its own hint. A step can land while a prompt is open: the Claude CLI prints
	 * its paste-code fallback (a prompt opens) before its `$BROWSER` helper reports the browser URL (`showAuth`).
	 * Clearing that prompt would leave the user no visible place to paste the code.
	 */
	private replaceContent(addStepRows: () => void): void {
		const open = this.inputResolver ? this.openPrompt : undefined;
		this.resetContent();
		addStepRows();
		if (open === undefined) return;
		for (const row of open.rows) this.contentContainer.addChild(row);
		this.remountInput(open.hint);
	}

	private cancel(): void {
		this.abortController.abort();
		if (this.inputRejecter) {
			this.inputRejecter(new Error("Login cancelled"));
			this.inputResolver = undefined;
			this.inputRejecter = undefined;
			this.openPrompt = undefined;
		}
		this.onComplete(false, "Login cancelled");
	}

	/**
	 * Called by onAuth callback - show URL and optional instructions
	 */
	showAuth(url: string, instructions?: string): void {
		this.replaceContent(() => {
			this.contentContainer.addChild(new Spacer(1));
			const displayUrl = redactOAuthUrl(url);
			const linkedUrl = `\x1b]8;;${displayUrl}\x07${displayUrl}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

			const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
			const hyperlink = `\x1b]8;;${displayUrl}\x07${clickHint}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));

			if (instructions) {
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("warning", instructions), 1, 0));
			}
		});

		openBrowser(url);
		this.tui.requestRender();
	}

	/**
	 * Called by onDeviceCode callback - show URL and user code.
	 */
	showDeviceCode(info: OAuthDeviceCodeInfo): void {
		this.replaceContent(() => {
			this.contentContainer.addChild(new Spacer(1));
			const linkedUrl = `\x1b]8;;${info.verificationUri}\x07${info.verificationUri}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("accent", linkedUrl), 1, 0));

			const clickHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
			const hyperlink = `\x1b]8;;${info.verificationUri}\x07${clickHint}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("dim", hyperlink), 1, 0));
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("warning", `Enter code: ${info.userCode}`), 1, 0));
		});

		this.tui.requestRender();
	}

	/**
	 * Show input for manual code/URL entry (for callback server providers)
	 */
	showManualInput(prompt: string): Promise<string> {
		this.input.setValue("");
		this.openPromptWith(
			[new Spacer(1), new Text(theme.fg("dim", prompt), 1, 0)],
			new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0),
		);
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/**
	 * Called by onPrompt callback - show prompt and wait for input
	 * Note: Does NOT clear content, appends to existing (preserves URL from showAuth)
	 */
	showPrompt(message: string, placeholder?: string): Promise<string> {
		const rows: Component[] = [new Spacer(1), new Text(theme.fg("text", message), 1, 0)];
		if (placeholder) rows.push(new Text(theme.fg("dim", `e.g., ${placeholder}`), 1, 0));
		this.openPromptWith(
			rows,
			new Text(
				`(${keyHint("tui.select.cancel", "to cancel,")} ${keyHint("tui.select.confirm", "to submit")})`,
				1,
				0,
			),
		);

		this.input.setValue("");
		this.tui.requestRender();

		return new Promise((resolve, reject) => {
			this.inputResolver = resolve;
			this.inputRejecter = reject;
		});
	}

	/** Show informational text before another login step. */
	showDetails(lines: string[]): void {
		this.replaceContent(() => {
			this.contentContainer.addChild(new Spacer(1));
			for (const line of lines) {
				this.contentContainer.addChild(new Text(line, 1, 0));
			}
		});
		this.tui.requestRender();
	}

	/** Show provider-owned information and links without starting an auth callback flow. */
	showInfo(message: string, links: readonly AuthInfoLink[] = [], showCloseHint = false): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("text", message), 1, 0));
		for (const link of links) {
			const text = link.label ? `${link.label}: ${link.url}` : link.url;
			const hyperlink = `\x1b]8;;${link.url}\x07${text}\x1b]8;;\x07`;
			this.contentContainer.addChild(new Text(theme.fg("accent", hyperlink), 1, 0));
		}
		if (showCloseHint) {
			this.contentContainer.addChild(new Spacer(1));
			this.setLiveHint(new Text(`(${keyHint("tui.select.cancel", "to close")})`, 1, 0));
		}
		this.tui.requestRender();
	}

	/**
	 * Show waiting message (for polling flows like GitHub Copilot)
	 */
	showWaiting(message: string): void {
		this.contentContainer.addChild(new Spacer(1));
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.setLiveHint(new Text(`(${keyHint("tui.select.cancel", "to cancel")})`, 1, 0));
		this.tui.requestRender();
	}

	/**
	 * Called by onProgress callback
	 */
	showProgress(message: string): void {
		this.contentContainer.addChild(new Text(theme.fg("dim", message), 1, 0));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.cancel")) {
			this.cancel();
			return;
		}

		// Pass to input
		this.input.handleInput(data);
	}
}
