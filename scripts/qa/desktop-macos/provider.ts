import type { ExtensionAPI } from "@code-yeongyu/senpi";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

export const QA_PROVIDER = "senpi-qa-desktop";
export const QA_MODEL = "qa-desktop";
export const QA_DONE = "qa-done";

/**
 * The scripted model of the macOS live QA driver, loaded into coding-agent with `-e`. A prompt that is a JSON
 * object becomes exactly one `computer` tool call with those arguments; any other prompt (`/computer ...`) is a
 * command the session dispatches itself. Provider events only: the session's real `computer` tool, permission
 * system, desktop-service, and engine handle the call.
 */
export default function desktopQaProvider(pi: ExtensionAPI): void {
	const faux = fauxProvider({
		api: QA_PROVIDER,
		provider: QA_PROVIDER,
		models: [{ id: QA_MODEL, input: ["text", "image"], contextWindow: 2_000_000, maxTokens: 4096 }],
	});
	pi.registerProvider(faux.provider);
	pi.on("input", (event) => {
		if (!event.text.startsWith("{")) return { action: "continue" };
		const args: Record<string, unknown> = JSON.parse(event.text);
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("computer", args), { stopReason: "toolUse" }),
			fauxAssistantMessage(QA_DONE),
		]);
		return { action: "continue" };
	});
}
