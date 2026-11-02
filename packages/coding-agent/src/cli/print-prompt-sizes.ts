import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.ts";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.ts";
import { initTheme } from "../modes/interactive/theme/theme.ts";
import { exitAfterOutput } from "./print-then-exit.ts";
import { cliPromptSizeInventory } from "./prompt-size-inventory.ts";

/** A full session open, followed only by preview composition; never starts a turn. */
export async function printPromptSizes(runtime: AgentSessionRuntime): Promise<never> {
	let code = 1;
	let output: unknown;
	try {
		if (!runtime.session.model) {
			output = { error: { reason: "no model selected" } };
		} else if (runtime.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
			output = { error: { reason: "session initialization failed" } };
		} else {
			initTheme(runtime.services.settingsManager.getTheme(), false);
			await runtime.session.bindExtensions({
				mode: "print",
				sizesOnly: true,
				promptSizeInventory: cliPromptSizeInventory,
			});
			const context = runtime.session.extensionRunner.createContext();
			const result = await context.getPromptCachePrefixRequest?.({ sizesOnly: true });
			if (result === undefined) {
				output = { error: { reason: "prompt size accounting unavailable" } };
			} else {
				switch (result.status) {
					case "ready":
						output = result.request.sizeReport ?? { error: { reason: "prompt size accounting unavailable" } };
						code = result.request.sizeReport ? 0 : 1;
						break;
					case "skipped":
						output = {
							error: {
								reason: [homedir(), realpathSync(homedir())]
									.sort((a, b) => b.length - a.length)
									.reduce((reason, home) => reason.replaceAll(`${home}/`, "~/"), result.reason),
							},
						};
						break;
					default: {
						const exhaustive: never = result;
						return exhaustive;
					}
				}
			}
		}
	} finally {
		await runtime.dispose();
	}
	writeRawStdout(`${JSON.stringify(output, null, 2)}\n`);
	await flushRawStdout();
	return exitAfterOutput("", code);
}
