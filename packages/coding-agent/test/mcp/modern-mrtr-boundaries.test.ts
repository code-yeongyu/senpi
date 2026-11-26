import { afterEach, describe, expect, it, vi } from "vitest";
import { queuedForm } from "../../src/core/extensions/builtin/mcp/modern/consent-queue.ts";
import type { MrtrInputResponse } from "../../src/core/extensions/builtin/mcp/modern/elicitation.ts";
import { mcpRequestOptions } from "../../src/core/extensions/builtin/mcp/request-origin.ts";
import { inputResult } from "./fixtures/mrtr-2026-server.ts";
import { cleanupMrtrLifecycle, fixture } from "./fixtures/mrtr-lifecycle.ts";
import { mrtrTui } from "./fixtures/mrtr-presentation.ts";

afterEach(cleanupMrtrLifecycle);

describe("MRTR local termination boundaries", () => {
	it("rejects an already-aborted unpresented form without manufacturing a cancel", async () => {
		const run = vi.fn();
		await expect(queuedForm({}, AbortSignal.abort(), run)).rejects.toMatchObject({
			code: "MCP_MRTR_PROCESSING_UNAVAILABLE",
		});
		expect(run).not.toHaveBeenCalled();
	});
	it("rejects a queued form aborted before presentation without an action", async () => {
		const binding = {};
		const entered = Promise.withResolvers<void>();
		const answer = Promise.withResolvers<MrtrInputResponse>();
		const first = queuedForm(binding, new AbortController().signal, async () => {
			entered.resolve();
			return await answer.promise;
		});
		await entered.promise;
		const controller = new AbortController();
		const run = vi.fn();
		const second = queuedForm(binding, controller.signal, run);
		const rejected = expect(second).rejects.toMatchObject({ code: "MCP_MRTR_PROCESSING_UNAVAILABLE" });
		controller.abort();
		try {
			await rejected;
			expect(run).not.toHaveBeenCalled();
		} finally {
			answer.resolve({ action: "cancel" });
			await first;
		}
	});
	it("prioritizes the round ceiling over an oversized ninth intermediate result", async () => {
		const f = await fixture([
			...Array.from({ length: 8 }, () => inputResult("round", {})),
			inputResult("x".repeat(70000), {}),
		]);
		const ui = mrtrTui();
		await expect(
			f.client.callTool({ name: "test" }, undefined, mcpRequestOptions(f.origin(ui.presentation))),
		).rejects.toMatchObject({ code: "MCP_MRTR_ROUND_LIMIT" });
		expect(f.transport.calls).toHaveLength(9);
	});
	it("preserves a numeric remote error code without exposing its message", async () => {
		const f = await fixture([undefined]);
		const pending = f.client.callTool({ name: "test" }).then(
			() => undefined,
			(error: unknown) => error,
		);
		await f.transport.received.promise;
		const request = f.transport.calls[0];
		if (!request || !("id" in request)) throw new Error("Missing live request");
		f.transport.onmessage?.({
			jsonrpc: "2.0",
			id: request.id,
			error: { code: -32023, message: "PRIVATE_REMOTE_MESSAGE_CANARY" },
		});
		const error = await pending;
		expect(error).toMatchObject({ code: "MCP_MRTR_TRANSPORT_FAILED", remoteCode: -32023 });
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error)) throw new Error("Expected typed local error");
		expect(error.message).toContain("-32023");
		expect(error.message).not.toContain("CANARY");
	});
});
