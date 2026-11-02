import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { SessionLogger } from "./session-log.ts";
import type { SessionTitleNoTextWarning, SessionTitleOutcome } from "./session-title-answer.ts";

// A failed title is asked for again at later turn ends, but only this many times per session, so a
// provider that fails the same way every time is not called on every prompt (#5471).
const MAX_SESSION_TITLE_FAILURES = 3;

interface SessionTitleTarget {
	readonly hasName: () => boolean;
	readonly setName: (title: string) => void;
	readonly notifyWarning: (message: string) => void;
	readonly logger: SessionLogger;
}

export class SessionTitleAttempts {
	private failures = 0;

	get exhausted(): boolean {
		return this.failures >= MAX_SESSION_TITLE_FAILURES;
	}

	apply(outcome: SessionTitleOutcome, model: Model<Api>, target: SessionTitleTarget): void {
		switch (outcome.kind) {
			case "titled":
				if (!target.hasName()) target.setName(outcome.title);
				return;
			case "fallback":
				if (target.hasName()) return;
				target.setName(outcome.title);
				target.logger.warn("session_title_fallback", {
					reason: outcome.warning.code,
					cause: outcome.warning.stopReason,
					tokens: outcome.warning.maxTokens,
					provider: model.provider,
					model: model.id,
				});
				target.notifyWarning(fallbackNotice(model, outcome.warning));
				return;
			case "unparsed":
				this.recordFailure("The title response had no <title> tag", target.logger);
				return;
			case "untitled":
				return;
		}
	}

	recordFailure(error: string, logger: SessionLogger): void {
		this.failures += 1;
		logger.debug("session_title_failed", { error, attempt: this.failures, willRetry: !this.exhausted });
	}
}

function fallbackNotice(model: Model<Api>, warning: SessionTitleNoTextWarning): string {
	return `${model.provider}/${model.id} returned no session title within ${warning.maxTokens} tokens (stop reason: ${warning.stopReason}); its reasoning may use the whole budget. The session is named from your first message; use /rename to change it.`;
}
