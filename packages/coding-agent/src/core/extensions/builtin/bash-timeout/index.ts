import type { ExtensionAPI, ExtensionContext } from "../../types.ts";
import { isAnthropicBashEnabled } from "../anthropic-bash/index.ts";
import { isEvalOnlyRouting } from "../eval-only-routing.ts";
import { resolveForegroundWindowSeconds } from "../terminal/tools/foreground-window.ts";

import {
	applyBashTimeout,
	type BashToolInputLike,
	buildBashTimeoutPrompt,
	resolveBashTimeoutDefaults,
} from "./timeout.ts";

export type { BashTimeoutDefaults, BashToolInputLike } from "./timeout.ts";
export {
	applyBashTimeout,
	BASH_DEFAULT_TIMEOUT_SECONDS,
	BASH_MAX_TIMEOUT_SECONDS,
	buildBashTimeoutPrompt,
	resolveBashTimeoutDefaults,
} from "./timeout.ts";

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

	/**
	 * Native Anthropic bash replaces the PTY `bash` tool and the terminal
	 * extension steps aside with it, so nothing implements the auto-detach the
	 * policy would otherwise advertise.
	 */
	const resolveWindow = (ctx: ExtensionContext | undefined): number | undefined => {
		if (isAnthropicBashEnabled() && ctx?.model?.api === "anthropic-messages") return undefined;
		return resolveForegroundWindowSeconds(env);
	};

	pi.on(
		"before_agent_start",
		async (event, ctx) => {
			// A session with no `bash` tool has nothing this policy can describe. A host that exposes
			// only the handler surface (no getAllTools) keeps the policy, as the terminal section does.
			if (typeof pi.getAllTools === "function" && !pi.getAllTools().some((tool) => tool.name === "bash")) {
				return undefined;
			}
			const foregroundWindowSeconds = resolveWindow(ctx);
			const prompt = buildBashTimeoutPrompt(defaults, {
				...(foregroundWindowSeconds === undefined ? {} : { foregroundWindowSeconds }),
				evalOnly: isEvalOnlyRouting(pi),
			});
			return { systemPrompt: `${event.systemPrompt}${prompt}` };
		},
		{ previewSafe: true },
	);
}
