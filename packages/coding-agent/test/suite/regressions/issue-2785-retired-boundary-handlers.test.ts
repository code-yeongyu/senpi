// Regression for #2785: a retired runner must not dispatch another boundary handler.
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { BoundaryContextPreview, ExtensionError, TurnEndEvent } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("retired boundary handlers (#2785)", () => {
	it("does not dispatch later turn_end handlers after the actual session is disposed", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let obsoleteCalls = 0;
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async () => {
						entered.resolve();
						await release.promise;
					});
				},
				(pi) => {
					pi.on("turn_end", (_event, ctx) => {
						obsoleteCalls++;
						ctx.sessionManager.getSessionId();
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		runner.onError((error) => errors.push(error));
		harness.setResponses([fauxAssistantMessage("final")]);
		// Drive the real AgentSession-installed finishTurn hook without waiting on
		// Session idle listeners that dispose intentionally removes.
		const prompt = harness.agent.prompt("finish one turn");
		try {
			await entered.promise;
			harness.session.dispose();
			expect(runner.isActive).toBe(false);
		} finally {
			release.resolve();
		}
		await prompt;
		expect(obsoleteCalls).toBe(0);
		expect(errors).toEqual([]);
	});

	it.each(["initial", "rebuild"] as const)("does not dispatch after retirement during %s preview", async (phase) => {
		let boundary: TurnEndEvent | undefined;
		let observedCalls = 0;
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						boundary = event;
					});
					pi.on("turn_end", (_event, ctx) => {
						observedCalls++;
						ctx.sessionManager.getSessionId();
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		runner.onError((error) => errors.push(error));
		harness.setResponses([fauxAssistantMessage("warm")]);
		await harness.session.prompt("capture a real boundary preview");
		if (!boundary) throw new Error("Warm turn did not emit turn_end");
		const preview = boundary.context;
		const initialCalls = observedCalls;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<BoundaryContextPreview>();
		let previewCalls = 0;
		const emission = runner.emitBoundary(boundary, () => {
			previewCalls++;
			if (previewCalls === (phase === "initial" ? 1 : 2)) {
				entered.resolve();
				return release.promise;
			}
			return preview;
		});
		try {
			await entered.promise;
			runner.invalidate("Retired by the next session");
		} finally {
			release.resolve(preview);
		}
		const result = await emission;
		expect(observedCalls).toBe(initialCalls);
		expect(errors).toEqual([]);
		expect(result.entries).toEqual([]);
		expect(result.continue).toBe(false);
		expect(result.valid).toBe(false);
	});

	it("does not report a handler that fails on the retired context it was awaiting", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", async (_event, ctx) => {
						entered.resolve();
						await release.promise;
						ctx.sessionManager.getSessionId();
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		runner.onError((error) => errors.push(error));
		harness.setResponses([fauxAssistantMessage("final")]);
		const prompt = harness.agent.prompt("finish one turn");
		try {
			await entered.promise;
			harness.session.dispose();
			expect(runner.isActive).toBe(false);
		} finally {
			release.resolve();
		}
		await prompt;
		expect(errors).toEqual([]);
	});

	it("does not report a boundary rebuild that fails after retirement", async () => {
		let boundary: TurnEndEvent | undefined;
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => {
						boundary = event;
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		runner.onError((error) => errors.push(error));
		harness.setResponses([fauxAssistantMessage("warm")]);
		await harness.session.prompt("capture a real boundary preview");
		if (!boundary) throw new Error("Warm turn did not emit turn_end");
		const preview = boundary.context;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<BoundaryContextPreview>();
		let previewCalls = 0;
		const emission = runner.emitBoundary(boundary, () => {
			previewCalls++;
			if (previewCalls === 2) {
				entered.resolve();
				return release.promise;
			}
			return preview;
		});
		try {
			await entered.promise;
			runner.invalidate("Retired by the next session");
		} finally {
			release.reject(new Error("Rebuilt a boundary preview after retirement"));
		}
		const result = await emission;
		expect(errors).toEqual([]);
		expect(result.entries).toEqual([]);
		expect(result.continue).toBe(false);
		expect(result.valid).toBe(false);
	});
});
