// Regression for #3149: retired-context failures are not genuine extension errors.
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext, ExtensionError } from "../../../src/core/extensions/types.ts";
import { createHarness, type Harness } from "../harness.ts";

const RETIRED = "Retired by the next session";

const harnesses: Harness[] = [];
afterEach(() => {
	while (harnesses.length > 0) harnesses.pop()?.cleanup();
});

describe("retired runner non-boundary dispatch (#3149)", () => {
	it("does not report a later agent_end handler that fails on the runner retired mid-turn", async () => {
		const errors: ExtensionError[] = [];
		let retire = (): void => {};
		let agentEndCalls = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", () => {
						retire();
					});
					pi.on("agent_end", (_event, ctx) => {
						agentEndCalls++;
						ctx.sessionManager.getSessionId();
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		retire = () => runner.invalidate(RETIRED);
		runner.onError((error) => errors.push(error));
		harness.setResponses([fauxAssistantMessage("final")]);

		await harness.session.prompt("finish one turn");

		expect(runner.isActive).toBe(false);
		expect(agentEndCalls).toBe(1);
		expect(errors).toEqual([]);
	});

	it("does not report request-time handlers that fail on a retired runner", async () => {
		const errors: ExtensionError[] = [];
		const dispatched: string[] = [];
		const touch = (event: string, ctx: ExtensionContext): void => {
			dispatched.push(event);
			ctx.sessionManager.getSessionId();
		};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", (_event, ctx) => touch("input", ctx));
					pi.on("before_agent_start", (_event, ctx) => touch("before_agent_start", ctx));
					pi.on("message_end", (_event, ctx) => touch("message_end", ctx));
					pi.on("agent_end", (_event, ctx) => touch("agent_end", ctx));
					pi.on("context", (_event, ctx) => touch("context", ctx));
					pi.on("context_with_system", (_event, ctx) => touch("context_with_system", ctx));
					pi.on("before_provider_request", (_event, ctx) => touch("before_provider_request", ctx));
					pi.on("before_provider_headers", (_event, ctx) => touch("before_provider_headers", ctx));
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		runner.invalidate(RETIRED);
		runner.onError((error) => errors.push(error));
		harness.setResponses([fauxAssistantMessage("after retirement")]);

		await harness.session.prompt("dispatch after retirement");
		await runner.emitContext([]);
		await runner.emitBeforeProviderRequest({});
		await runner.emitBeforeProviderHeaders({});

		expect(new Set(dispatched)).toEqual(
			new Set([
				"input",
				"before_agent_start",
				"message_end",
				"agent_end",
				"context",
				"context_with_system",
				"before_provider_request",
				"before_provider_headers",
			]),
		);
		expect(errors).toEqual([]);
	});

	it.each(["GENUINE_HANDLER_FAILURE", `GENUINE_HANDLER_FAILURE: ${RETIRED}`])(
		"reports a genuine lifecycle and context failure after retirement: %s",
		async (failure) => {
			const errors: ExtensionError[] = [];
			const fail = (): never => {
				throw new Error(failure);
			};
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("agent_end", fail);
						pi.on("context", fail);
						pi.on("context_with_system", fail);
					},
				],
			});
			harnesses.push(harness);
			const runner = harness.getExtensionRunner();
			runner.invalidate(RETIRED);
			runner.onError((error) => errors.push(error));

			await runner.emit({ type: "agent_end", messages: [] });
			await runner.emitContext([]);

			expect(errors).toMatchObject([
				{ event: "agent_end", error: failure },
				{ event: "context", error: failure },
				{ event: "context_with_system", error: failure },
			]);
		},
	);

	it("still reports a non-boundary handler failure while the runner is active", async () => {
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_end", () => {
						throw new Error("ACTIVE_AGENT_END_FAILURE");
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		runner.onError((error) => errors.push(error));
		harness.setResponses([fauxAssistantMessage("final")]);

		await harness.session.prompt("finish one turn");

		expect(runner.isActive).toBe(true);
		expect(errors).toMatchObject([{ event: "agent_end", error: "ACTIVE_AGENT_END_FAILURE" }]);
	});

	it("still reports a genuine failure from a cleanup handler dispatched on the retired runner", async () => {
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_extensions_removed", () => {
						throw new Error("CLEANUP_FAILED");
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		runner.onError((error) => errors.push(error));
		// A session replacement disposes the old session first, then reports removed extensions on its runner.
		runner.invalidate(RETIRED);
		await runner.emit({
			type: "session_extensions_removed",
			reason: "new",
			removed: [{ path: "removed.ts", resolvedPath: "/removed.ts" }],
		});

		expect(errors).toMatchObject([{ event: "session_extensions_removed", error: "CLEANUP_FAILED" }]);
	});

	it("still reports a command that uses its context after the runner retires", async () => {
		const errors: ExtensionError[] = [];
		let retire = (): void => {};
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerCommand("use-after-retire", {
						description: "Retires the runner, then reads the captured context",
						handler: async (_args, ctx) => {
							retire();
							ctx.sessionManager.getSessionId();
						},
					});
				},
			],
		});
		harnesses.push(harness);
		const runner = harness.getExtensionRunner();
		retire = () => runner.invalidate(RETIRED);
		runner.onError((error) => errors.push(error));

		await harness.session.prompt("/use-after-retire");

		expect(runner.isActive).toBe(false);
		expect(errors).toMatchObject([{ extensionPath: "command:use-after-retire", event: "command", error: RETIRED }]);
	});
});
