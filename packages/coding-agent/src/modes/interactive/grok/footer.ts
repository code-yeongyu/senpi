import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
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
		// The grok footer intentionally presents model and cwd only.
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
		return [truncateToWidth(`${tokens.cwd(cwd)} ${tokens.modelLabel(model)}`, width, "")];
	}
}
