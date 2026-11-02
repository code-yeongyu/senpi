import type { ExtensionAPI } from "../../types.ts";
import { applyBashTimeout, type BashToolInputLike, resolveBashTimeoutDefaults } from "./timeout.ts";

export type { BashTimeoutDefaults, BashToolInputLike } from "./timeout.ts";
export { applyBashTimeout, BASH_DEFAULT_TIMEOUT_SECONDS, resolveBashTimeoutDefaults } from "./timeout.ts";

export default function bashTimeoutExtension(pi: ExtensionAPI): void {
	const env = typeof process !== "undefined" ? process.env : {};
	const defaults = resolveBashTimeoutDefaults(env);

	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		const input = event.input as BashToolInputLike;
		const updated = applyBashTimeout(input, defaults);
		if (updated !== input) {
			const timeout = updated.timeout;
			if (timeout !== undefined) input.timeout = timeout;
		}
	});

	// The timeout facts reach the model through the terminal section (senpi#5335); this extension adds no prompt text.
}
