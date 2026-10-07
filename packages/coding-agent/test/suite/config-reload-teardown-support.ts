import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { expect } from "vitest";
import { createConfigReloadHarness } from "./config-reload-harness.ts";
import { getAssistantTexts } from "./harness.ts";

export type TeardownPromptResult = {
	readonly order: readonly string[];
	readonly replies: readonly string[];
	readonly providerRequests: number;
};

/**
 * Submits a prompt while an explicit reload waits inside the old runtime's shutdown handlers. The
 * rebuilt runtime's `session_start` (reason "reload") is subscribed before the reload is triggered,
 * so the recorded order shows whether the request started before or after the rebuild completed.
 */
export async function promptDuringReloadTeardown(api?: string): Promise<TeardownPromptResult> {
	await using root = await mkdtempDisposable(join(tmpdir(), "config-reload-teardown-"));
	const shutdownEntered = Promise.withResolvers<void>();
	const releaseShutdown = Promise.withResolvers<void>();
	const order: string[] = [];
	const { harness } = await createConfigReloadHarness(
		root.path,
		(pi) => {
			pi.on("session_shutdown", async (event) => {
				if (event.reason !== "reload") return;
				shutdownEntered.resolve();
				await releaseShutdown.promise;
			});
			pi.on("session_start", (event) => {
				if (event.reason === "reload") order.push("runtime rebuilt");
			});
			pi.on("before_agent_start", () => {
				order.push("request started");
			});
		},
		api === undefined ? {} : { api },
	);
	let reload: Promise<{ cancelled: boolean }> | undefined;
	let prompt: Promise<void> | undefined;
	try {
		harness.setResponses([fauxAssistantMessage("Request after reload completed.")]);
		reload = harness.session.reload();
		await shutdownEntered.promise;
		// The user submits a message before the rebuild has finished.
		prompt = harness.session.prompt("Handle the request");
		releaseShutdown.resolve();
		expect(await reload).toMatchObject({ cancelled: false });
		await prompt;
		return { order, replies: getAssistantTexts(harness), providerRequests: harness.faux.getCallLog().length };
	} finally {
		releaseShutdown.resolve();
		await reload;
		await prompt;
		await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
}
