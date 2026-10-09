import { Container, Markdown, Text, type TUI } from "@earendil-works/pi-tui";
import { DynamicBorder } from "../../../../modes/interactive/components/dynamic-border.ts";
import { getMarkdownTheme, type Theme } from "../../../../modes/interactive/theme/theme.ts";

export type BtwPanelStatus = "streaming" | "done" | "error" | "aborted";

export class BtwPanel {
	private readonly container: Container;
	private readonly header: Text;
	private readonly body: Markdown;
	private readonly footer: Text;
	private readonly question: string;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private answer = "";
	private status: BtwPanelStatus = "streaming";
	private detail = "";

	constructor(question: string, tui: TUI, theme: Theme) {
		this.question = question;
		this.tui = tui;
		this.theme = theme;
		this.container = new Container();
		this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("muted", s)));
		this.header = new Text("", 1, 0);
		this.body = new Markdown("", 1, 0, getMarkdownTheme());
		this.footer = new Text("", 1, 0);
		this.container.addChild(this.header);
		this.container.addChild(this.body);
		this.container.addChild(this.footer);
		this.container.addChild(new DynamicBorder((s: string) => this.theme.fg("muted", s)));
		this.repaint();
	}

	get component(): Container {
		return this.container;
	}

	appendText(delta: string): void {
		this.answer += delta;
		this.repaint();
	}

	markDone(): void {
		this.status = "done";
		this.repaint();
	}

	markError(message: string): void {
		this.status = "error";
		this.detail = message;
		this.repaint();
	}

	markAborted(): void {
		this.status = "aborted";
		this.repaint();
	}

	private repaint(): void {
		const thm = this.theme;
		this.header.setText(thm.fg("accent", thm.bold("btw: ")) + thm.fg("text", this.question));
		this.body.setText(this.answer);
		let footer: string;
		switch (this.status) {
			case "streaming":
				footer = thm.fg("dim", "answering… (/btw or Esc to cancel)");
				break;
			case "done":
				footer = thm.fg("dim", "(/btw or Esc to dismiss; clears on next message)");
				break;
			case "error":
				footer = thm.fg("error", `error: ${this.detail}`);
				break;
			case "aborted":
				footer = thm.fg("dim", "(dismissed)");
				break;
		}
		this.footer.setText(footer);
		this.tui.requestRender();
	}
}
