import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { cliPromptSizeInventory } from "../cli/prompt-size-inventory.ts";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import type { PromptSizeReport } from "../core/prompt-size-report.ts";
import { initTheme } from "../modes/interactive/theme/theme.ts";
import { type EngineResult, engineError, engineOk } from "./result.ts";

/** `reason` of the refusal: why no size could be measured. */
export type PromptSizesCode = "unmeasurable";

const UNAVAILABLE = "prompt size accounting unavailable";

function homeRelative(reason: string): string {
	return [homedir(), realpathSync(homedir())]
		.sort((a, b) => b.length - a.length)
		.reduce((text, home) => text.replaceAll(`${home}/`, "~/"), reason);
}

/**
 * The size of each part of the first request a session would send, composed as a preview that never
 * starts a turn. The runtime is the caller's to dispose.
 */
export async function measurePromptSizes(
	runtime: AgentSessionRuntime,
): Promise<EngineResult<PromptSizeReport, PromptSizesCode>> {
	if (!runtime.session.model) return engineError("unmeasurable", "no model selected");
	if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
		return engineError("unmeasurable", "session initialization failed");
	}
	initTheme(runtime.services.settingsManager.getTheme(), false);
	await runtime.session.bindExtensions({
		mode: "print",
		sizesOnly: true,
		promptSizeInventory: cliPromptSizeInventory,
	});
	const context = runtime.session.extensionRunner.createContext();
	const result = await context.getPromptCachePrefixRequest?.({ sizesOnly: true });
	if (result === undefined) return engineError("unmeasurable", UNAVAILABLE);
	switch (result.status) {
		case "ready":
			return result.request.sizeReport
				? engineOk(result.request.sizeReport)
				: engineError("unmeasurable", UNAVAILABLE);
		case "skipped":
			return engineError("unmeasurable", homeRelative(result.reason));
		default: {
			const exhaustive: never = result;
			return exhaustive;
		}
	}
}
