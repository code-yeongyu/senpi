import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { threadId } from "node:worker_threads";

/** The inherited --import preload observes the kernel worker as well as its host. */
registerHooks({
	resolve(specifier, context, nextResolve) {
		const result = nextResolve(specifier, context);
		const path = process.env.SENPI_GATE_IMPORT_FILE;
		const phase = process.env.SENPI_GATE_IMPORT_PHASE;
		if (path !== undefined && phase !== undefined && !result.url.includes("/scripts/gate-"))
			appendFileSync(path, `${JSON.stringify({
				phase, url: result.url, thread: threadId, parent: context.parentURL, specifier,
			})}\n`);
		return result;
	},
});
