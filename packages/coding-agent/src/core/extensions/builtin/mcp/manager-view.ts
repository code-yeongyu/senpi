import {
	type Component,
	Container,
	type KeybindingsManager,
	type SelectItem,
	SelectList,
	Spacer,
	sanitizeTerminalLabel,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../../../modes/interactive/components/keybinding-hints.ts";
import { getSelectListTheme, type Theme } from "../../../../modes/interactive/theme/theme.ts";

export interface McpManagerMenu {
	readonly title: string;
	readonly items: SelectItem[];
	readonly details?: string;
	readonly empty?: string;
	readonly confirmLabel: string;
	readonly cancelLabel: string;
	readonly selected?: string;
}

/** A focused menu that rebuilds on MCP events, never on a polling timer. */
export class McpManagerView implements Component {
	private content = new Container();
	private inputHandler: ((data: string) => void) | undefined;
	private cancelMenu: (() => void) | undefined;
	private rebuild: (() => void) | undefined;
	private width: number | undefined;
	private rows: number | undefined;
	private disposed = false;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.status("MCP servers", "Loading...");
	}

	menu(
		build: () => McpManagerMenu | Promise<McpManagerMenu>,
		subscribe?: (listener: () => void) => () => void,
	): Promise<string | undefined> {
		if (this.disposed) return Promise.resolve(undefined);
		return new Promise((resolve, reject) => {
			let generation = 0;
			let settled = false;
			let selected: string | undefined;
			let unsubscribe: (() => void) | undefined;
			const finish = (value: string | undefined, error?: unknown): void => {
				if (settled) return;
				settled = true;
				generation++;
				unsubscribe?.();
				this.cancelMenu = undefined;
				this.rebuild = undefined;
				this.inputHandler = undefined;
				if (error !== undefined) reject(error);
				else resolve(value);
			};
			const render = async (): Promise<void> => {
				const current = ++generation;
				try {
					const menu = await build();
					if (settled || current !== generation) return;
					const list = new SelectList(
						menu.items.map((item) => ({
							...item,
							label: sanitizeTerminalLabel(item.label || item.value) || "(empty)",
							description: item.description === undefined ? undefined : sanitizeTerminalLabel(item.description),
						})),
						Math.max(1, Math.min(12, this.tui.terminal.rows - 10)),
						getSelectListTheme(),
					);
					const wanted = selected ?? menu.selected;
					const index = menu.items.findIndex((item) => item.value === wanted);
					if (index !== -1) list.setSelectedIndex(index);
					selected = list.getSelectedItem()?.value;
					list.onSelectionChange = (item) => {
						selected = item.value;
					};
					list.onSelect = (item) => finish(item.value);
					list.onCancel = () => finish(undefined);
					const body: Component[] = [];
					if (menu.details)
						body.push(
							new Text(
								this.theme.fg("muted", menu.details.split("\n").map(sanitizeTerminalLabel).join("\n")),
								1,
								0,
							),
						);
					body.push(new Spacer(1));
					body.push(
						menu.items.length > 0
							? list
							: new Text(sanitizeTerminalLabel(menu.empty ?? "Nothing to show."), 1, 0),
					);
					const footer =
						menu.items.length > 0
							? `${keyHint("tui.select.confirm", menu.confirmLabel)} | ${keyHint("tui.select.cancel", menu.cancelLabel)}`
							: keyHint("tui.select.cancel", menu.cancelLabel);
					this.setContent(menu.title, body, footer);
					this.inputHandler = (data) => {
						if (menu.items.length > 0) list.handleInput(data);
						else if (this.keybindings.matches(data, "tui.select.cancel")) finish(undefined);
					};
				} catch (error) {
					if (!settled && current === generation) finish(undefined, error);
				}
			};
			this.cancelMenu = () => finish(undefined);
			this.rebuild = () => void render();
			this.inputHandler = (data) => {
				if (this.keybindings.matches(data, "tui.select.cancel")) finish(undefined);
			};
			unsubscribe = subscribe?.(() => void render());
			void render();
		});
	}

	status(title: string, message: string): void {
		this.setContent(title, [
			new Spacer(1),
			new Text(this.theme.fg("muted", message.split("\n").map(sanitizeTerminalLabel).join("\n")), 1, 0),
		]);
	}

	get columns(): number {
		return this.tui.terminal.columns;
	}

	private setContent(title: string, body: readonly Component[], footer?: string): void {
		if (this.disposed) return;
		this.content = new Container();
		this.content.addChild(new DynamicBorder((text) => this.theme.fg("accent", text)));
		this.content.addChild(new Text(this.theme.fg("accent", this.theme.bold(sanitizeTerminalLabel(title))), 1, 0));
		for (const child of body) this.content.addChild(child);
		if (footer) {
			this.content.addChild(new Spacer(1));
			this.content.addChild(new Text(footer, 1, 0));
		}
		this.content.addChild(new DynamicBorder((text) => this.theme.fg("accent", text)));
		this.tui.requestRender();
	}

	handleInput(data: string): void {
		this.inputHandler?.(data);
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (this.width !== width || this.rows !== this.tui.terminal.rows) {
			this.width = width;
			this.rows = this.tui.terminal.rows;
			this.rebuild?.();
		}
		return this.content.render(width).map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.content.invalidate();
		this.rebuild?.();
	}

	dispose(): void {
		this.disposed = true;
		this.cancelMenu?.();
	}
}
