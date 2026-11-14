import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../../../core/footer-data-provider.ts";
import { getGrokChromeTokens } from "./chrome-tokens.ts";

/** Compact status footer for grok chrome. */
export class GrokFooter implements Component {
	private session: AgentSession;

	constructor(session: AgentSession, _footerData: ReadonlyFooterDataProvider) {
		this.session = session;
	}

	setSession(session: AgentSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(_enabled: boolean): void {
		// Auto-compaction is not shown in the compact footer.
	}

	invalidate(): void {
		// Values are read directly from the session during rendering.
	}

	dispose(): void {
		// No resources are owned by this footer.
	}

	render(width: number): string[] {
		const tokens = getGrokChromeTokens();
		const cwd = this.session.sessionManager.getCwd();
		const model = this.session.state.model?.id ?? "no-model";
		const level = this.session.supportsThinking() ? `:${this.session.thinkingLevel}` : "";
		const modelLabel = tokens.modelLabel(
			`${truncateToWidth(model, Math.max(0, width - visibleWidth(level)), "")}${level}`,
		);
		const cwdWidth = Math.max(0, width - visibleWidth(modelLabel) - 1);
		const prefix = cwdWidth > 0 ? `${truncateToWidth(tokens.cwd(cwd), cwdWidth, "")} ` : "";
		return [truncateToWidth(`${prefix}${modelLabel}`, width, "")];
	}
}
