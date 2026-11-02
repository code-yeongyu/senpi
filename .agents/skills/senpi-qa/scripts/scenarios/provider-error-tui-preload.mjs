// Loaded only by provider-error-tui-qa.mjs. The real CLI constructs and owns the TUI.
import { InteractiveMode } from "../../../../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";

const raw = JSON.stringify({ type: "error", error: { type: "api_error", message: "Network error or service unavailable" } });
const originalInit = InteractiveMode.prototype.init;
const scenario = process.env.SENPI_QA_PROVIDER_SCENARIO;
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
function message(text = "", failed = true) {
	return {
		role: "assistant", content: text ? [{ type: "text", text }] : [],
		api: "openai-completions", provider: "mock", model: "mock-model",
		stopReason: failed ? "error" : "stop", errorMessage: failed ? raw : undefined,
		timestamp: 1, usage: { ...zero, totalTokens: 0, cost: { ...zero } },
	};
}

InteractiveMode.prototype.init = async function (...args) {
	await originalInit.apply(this, args);
	const mode = this;
	let phase = 0;
	let busy = false;
	const event = (value) => mode.handleEvent(value);
	async function user(text) {
		await event({ type: "message_start", message: { role: "user", content: text, timestamp: 1 } });
	}
	async function failures() {
		for (let attempt = 1; attempt <= 17; attempt++) {
			const failed = message(attempt === 1 ? "PARTIAL_CONTENT_PRESERVED" : "");
			// Preserve synthetic diagnostics in this sandbox's real SessionManager too.
			mode.sessionManager.appendMessage(failed);
			await event({ type: "message_start", message: failed });
			await event({ type: "message_end", message: failed });
			await event({ type: "auto_retry_start", attempt, maxAttempts: 17, delayMs: 60000, errorMessage: raw });
		}
	}
	async function advance() {
		if (busy) return;
		busy = true;
		try {
			phase++;
			if (phase === 1) {
				await user(`FIXTURE ${scenario}`);
				await failures();
			} else if (phase === 2) {
				if (scenario === "cancelled") {
					await event({ type: "session_abort" });
					await event({ type: "auto_retry_end", success: false, attempt: 17, finalError: "Retry cancelled" });
				} else if (scenario === "exhausted" || scenario === "separate-turns") {
					await event({ type: "auto_retry_end", success: false, attempt: 17, finalError: raw });
				} else if (scenario === "replay") {
					mode.clearStatusIndicator();
					mode.chatContainer.clear();
					const history = [{ role: "user", content: "REPLAY", timestamp: 1 },
						...Array.from({ length: 17 }, (_, i) => message(i === 0 ? "PARTIAL_CONTENT_PRESERVED" : ""))];
					mode.renderSessionItems(history);
				} else {
					const recovered = message("RECOVERED_ANSWER", false);
					mode.sessionManager.appendMessage(recovered);
					await event({ type: "message_start", message: recovered });
					await event({ type: "message_end", message: recovered });
					await event({ type: "auto_retry_end", success: true, attempt: 17 });
				}
			} else if (phase === 3 && scenario === "separate-turns") {
				await user("SECOND_INDEPENDENT_TURN");
				await failures();
				await event({ type: "auto_retry_end", success: false, attempt: 17, finalError: raw });
			} else {
				mode.setToolsExpanded(true);
			}
			mode.showStatus(`FIXTURE_PHASE_${phase} [n: next; q: quit]`);
			mode.ui.requestRender(true);
			process.send?.({ type: "fixture-phase", phase, scenario });
		} finally {
			busy = false;
		}
	}
	mode.ui.addInputListener((data) => {
		if (data === "q") {
			mode.clearStatusIndicator();
			mode.ui.stop();
			process.exit(0);
		}
		if (data === "n") {
			void advance().catch((error) => {
				process.send?.({ type: "fixture-error", message: String(error) });
				process.exit(1);
			});
		}
		return { consume: true };
	});
	// The parent waits for this signal, not elapsed startup time, before sending input.
	mode.showStatus("FIXTURE_READY [n: next; q: quit]");
	mode.ui.requestRender(true);
	process.send?.({ type: "fixture-ready", scenario });
};
