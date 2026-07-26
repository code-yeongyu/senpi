import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../../src/core/extensions/types.ts";
import { createHarness } from "../harness.ts";

const STALE_EXTENSION_CONTEXT_ERROR_PREFIX = "This extension ctx is stale after session replacement or reload.";

describe("stale extension contexts after session replacement", () => {
	it("passes a provider payload through without spraying extension errors while preserving direct stale-context diagnostics", async () => {
		let capturedContext: ExtensionContext | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_provider_request", (event, ctx) => {
						capturedContext ??= ctx;
						void ctx.cwd;
						return { ...(event.payload as object), handled: true };
					});
				},
			],
		});

		try {
			const onPayload = harness.agent.onPayload;
			if (!onPayload) throw new Error("Expected the agent provider payload hook");

			const activePayload = { phase: "active" };
			await expect(onPayload(activePayload, harness.getModel())).resolves.toEqual({
				phase: "active",
				handled: true,
			});
			const activeContext = capturedContext;
			if (!activeContext) throw new Error("Expected an extension context from the active provider request");

			const errors: string[] = [];
			harness.getExtensionRunner().onError((error) => {
				errors.push(error.error);
			});
			harness.session.dispose();

			const stalePayload = { phase: "stale" };
			await expect(onPayload(stalePayload, harness.getModel())).resolves.toBe(stalePayload);
			expect(errors).toEqual([]);
			expect(() => activeContext.cwd).toThrow(STALE_EXTENSION_CONTEXT_ERROR_PREFIX);
		} finally {
			harness.cleanup();
		}
	});
});
