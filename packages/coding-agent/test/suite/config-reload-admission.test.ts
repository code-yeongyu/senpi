import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigReloadHarness } from "./config-reload-harness.ts";
import { promptDuringReloadTeardown } from "./config-reload-teardown-support.ts";

afterEach(() => vi.useRealTimers());

describe("config reload during first-message admission", () => {
	// omo#9365: a prompt can be admitted before the provider's agent run is marked active.
	it("defers a configuration reload until the admitted first request finishes", async () => {
		// Given: the real session is waiting on an asynchronous first-turn extension.
		await using root = await mkdtempDisposable(join(tmpdir(), "config-admission-"));
		await writeFile(join(root.path, "settings.json"), '{"theme":"dark"}');
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { harness, reloads, notify } = await createConfigReloadHarness(root.path, (pi) => {
			pi.on("before_agent_start", async () => {
				entered.resolve();
				await release.promise;
			});
		});
		harness.setResponses([fauxAssistantMessage("First request completed.")]);
		vi.useFakeTimers();
		const prompt = harness.session.prompt("Handle the first request");
		try {
			await entered.promise;
			// When: a watched configuration file changes during prompt admission.
			await writeFile(join(root.path, "settings.json"), '{"theme":"light"}');
			await notify(root.path, "settings.json");
			// Then: the host is not asked to retire the extension handling that request.
			expect([...reloads]).toEqual([]);
			expect(await harness.session.reload()).toMatchObject({ cancelled: true });
			release.resolve();
			await prompt;
			expect(reloads).toEqual([true]);
		} finally {
			release.resolve();
			await prompt;
			await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
			harness.cleanup();
		}
	});

	it("starts a prompt submitted during reload teardown only after the runtime is rebuilt", async () => {
		// Given/When: a prompt arrives while an explicit reload is inside the old runtime's shutdown handlers.
		const result = await promptDuringReloadTeardown();
		// Then: the request starts on the rebuilt runtime and its reply reaches the user on the first attempt.
		expect(result.order).toEqual(["runtime rebuilt", "request started"]);
		expect(result.replies).toEqual(["Request after reload completed."]);
		expect(result.providerRequests).toBe(1);
	});

	it.each(["admission", "provider"] as const)(
		"rechecks reload safety when %s starts during an asynchronous veto",
		async (phase) => {
			// Given: a pending configuration reload is still consulting an extension.
			await using root = await mkdtempDisposable(join(tmpdir(), "config-veto-admission-"));
			await writeFile(join(root.path, "settings.json"), '{"theme":"dark"}');
			const vetoEntered = Promise.withResolvers<void>();
			const releaseVeto = Promise.withResolvers<void>();
			const requestEntered = Promise.withResolvers<void>();
			const releaseRequest = Promise.withResolvers<void>();
			const { harness, reloads, notify } = await createConfigReloadHarness(root.path, (pi) => {
				pi.on("session_before_reload", async () => {
					vetoEntered.resolve();
					await releaseVeto.promise;
				});
				pi.on("before_agent_start", async () => {
					if (phase === "admission") {
						requestEntered.resolve();
						await releaseRequest.promise;
					}
				});
			});
			harness.setResponses([
				async () => {
					if (phase === "provider") {
						requestEntered.resolve();
						await releaseRequest.promise;
					}
					return fauxAssistantMessage("First request completed.");
				},
			]);
			vi.useFakeTimers();
			await writeFile(join(root.path, "settings.json"), '{"theme":"light"}');
			await notify(root.path, "settings.json");
			await vetoEntered.promise;
			const prompt = harness.session.prompt("Handle the first request");
			try {
				await requestEntered.promise;
				// When: the old idle check finishes after the first request has started.
				releaseVeto.resolve();
				await vi.advanceTimersByTimeAsync(0);
				// Then: reload stays pending until that request has settled.
				expect([...reloads]).toEqual([]);
				releaseRequest.resolve();
				await prompt;
				expect(reloads).toEqual([true]);
			} finally {
				releaseVeto.resolve();
				releaseRequest.resolve();
				await prompt;
				await harness.getExtensionRunner().emit({ type: "session_shutdown", reason: "quit" });
				harness.cleanup();
			}
		},
	);
});
