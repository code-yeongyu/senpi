import type { Component, EditorOptions, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { WorkingIndicatorOptions } from "../../../core/extensions/index.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { CustomEditor } from "../components/custom-editor.ts";
import { WorkingStatusIndicator } from "../components/status-indicator.ts";
import type { ToolExecutionPresentation } from "../components/tool-execution.ts";
import { theme } from "../theme/theme.ts";
import { getGrokChromeTokens } from "./chrome-tokens.ts";
import { GrokFooter } from "./footer.ts";
import { GrokInputCard } from "./input-card.ts";
import { GROK_GLYPHS } from "./palette.ts";
import { GrokWelcomeCard } from "./welcome-card.ts";

export interface InteractiveFooter extends Component {
	setSession(session: AgentSession): void;
	setAutoCompactEnabled(enabled: boolean): void;
	invalidate(): void;
	dispose(): void;
}

export type EditorBorderContext = {
	readonly isBashMode: boolean;
	readonly thinkingLevel: string;
};

/**
 * Mode-owned chrome seam for InteractiveMode. Extensions continue to own their
 * editor factory; this strategy only creates and decorates the base editor.
 */
export interface InteractiveChrome {
	readonly toolPresentation: ToolExecutionPresentation;
	createBaseEditor(context: { ui: TUI; keybindings: KeybindingsManager; editorOptions: EditorOptions }): CustomEditor;
	getEditorTheme(): EditorTheme;
	createFooter(session: AgentSession, footerData: ReadonlyFooterDataProvider): InteractiveFooter;
	createWelcomeContent(appName: string, version: string): Component;
	createWorkingIndicator(ui: TUI, message: string, indicator?: WorkingIndicatorOptions): WorkingStatusIndicator;
	getEditorBorderColor(context: EditorBorderContext): (text: string) => string;
	arrangeRoot(children: readonly Component[], ui?: TUI): Component[];
}

class GrokFooterSurface implements Component {
	private readonly content: Component;

	constructor(content: Component) {
		this.content = content;
	}

	invalidate(): void {
		this.content.invalidate();
	}

	render(width: number): string[] {
		const surface = getGrokChromeTokens().surface;
		return this.content.render(width).map(surface);
	}

	dispose(): void {
		this.content.dispose?.();
	}
}

class GrokRootSpacer implements Component {
	private readonly ui: TUI;
	private readonly content: readonly Component[];

	constructor(ui: TUI, content: readonly Component[]) {
		this.ui = ui;
		this.content = content;
	}

	invalidate(): void {
		// The spacer derives its height from the current terminal dimensions.
	}

	render(width: number): string[] {
		const contentHeight = this.content.reduce((height, component) => height + component.render(width).length, 0);
		return Array.from({ length: Math.max(0, this.ui.terminal.rows - contentHeight) }, () => "");
	}
}

class GrokEditor extends CustomEditor {
	private readonly card: GrokInputCard;

	constructor(ui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager, options: EditorOptions) {
		super(ui, editorTheme, keybindings, options);
		this.card = new GrokInputCard({
			render: (width) => this.renderBase(width),
			invalidate: () => super.invalidate(),
		});
	}

	override render(width: number): string[] {
		return this.card.render(width);
	}

	private renderBase(width: number): string[] {
		return super.render(width);
	}
}

export class GrokChrome implements InteractiveChrome {
	readonly toolPresentation = "grok" as const;

	createBaseEditor({
		ui,
		keybindings,
		editorOptions,
	}: {
		ui: TUI;
		keybindings: KeybindingsManager;
		editorOptions: EditorOptions;
	}): CustomEditor {
		return new GrokEditor(ui, this.getEditorTheme(), keybindings, editorOptions);
	}

	getEditorTheme(): EditorTheme {
		const tokens = getGrokChromeTokens();
		return {
			borderColor: tokens.inputBorder,
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => tokens.primaryText(text),
				description: (text) => tokens.mutedText(text),
				scrollInfo: (text) => tokens.mutedText(text),
				noMatch: (text) => tokens.mutedText(text),
				renderRow: ({ prefix, primary, description, isSelected }) => {
					const row = `${prefix}${tokens.primaryText(primary)}${description ? tokens.mutedText(description) : ""}`;
					return isSelected ? theme.bg("selectedBg", row) : row;
				},
			},
		};
	}

	createFooter(session: AgentSession, footerData: ReadonlyFooterDataProvider): InteractiveFooter {
		return new GrokFooter(session, footerData);
	}

	createWelcomeContent(appName: string, version: string): Component {
		return new GrokWelcomeCard(appName, version);
	}

	createWorkingIndicator(ui: TUI, message: string, indicator?: WorkingIndicatorOptions): WorkingStatusIndicator {
		return new WorkingStatusIndicator(ui, message, {
			...indicator,
			frames: [GROK_GLYPHS.spinner],
			indicatorFormatter: (frame) => theme.fg("accent", frame),
		});
	}

	getEditorBorderColor(_context: EditorBorderContext): (text: string) => string {
		return getGrokChromeTokens().inputBorder;
	}

	arrangeRoot(children: readonly Component[], ui?: TUI): Component[] {
		// pi-tui concatenates root children without a layout pass. Keep transcript
		// content first and calculate the remaining rows at render time from the TUI's
		// terminal height, so the input tail is truly bottom-anchored when it fits.
		const inputTailStart = Math.max(0, children.length - 3);
		const content = children.slice(0, inputTailStart);
		const inputTail = children.slice(inputTailStart);
		const footer = inputTail.at(-1);
		const tail = footer ? [...inputTail.slice(0, -1), new GrokFooterSurface(footer)] : [...inputTail];
		const arranged = [...content, ...tail];
		return ui ? [...content, new GrokRootSpacer(ui, arranged), ...tail] : arranged;
	}
}
