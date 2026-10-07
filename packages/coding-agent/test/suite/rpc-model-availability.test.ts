import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createRpcConnectionHandler } from "../../src/modes/rpc/connection-handler.ts";
import { makeHarness, makeSink } from "./rpc-connection-harness.ts";

describe("RPC model availability after credentials change in another session", () => {
	it.each([true, false])("reflects configured=%s without reopening the session", async (configured) => {
		const tempDir = mkdtempSync(join(tmpdir(), "rpc-model-availability-"));
		const harness = makeHarness(tempDir);
		const collected = makeSink();
		const handler = createRpcConnectionHandler(harness.runtimeHost, collected.sink);
		try {
			const writer = AuthStorage.create(harness.authPath);
			if (!configured) writer.set("openai", { type: "api_key", key: "synthetic-test-key" });
			await harness.runtimeHost.session.modelRegistry.refresh();
			await handler.handleInputLine(JSON.stringify({ id: "before", type: "get_available_models" }));
			const before = await collected.waitFor((message) => message.id === "before");
			expect(before).toMatchObject({ success: true });
			expect(JSON.stringify(before.data).includes('"provider":"openai"')).toBe(!configured);

			if (configured) writer.set("openai", { type: "api_key", key: "synthetic-test-key" });
			else writer.remove("openai");
			const response = collected.waitFor((message) => message.id === "after");
			await handler.handleInputLine(JSON.stringify({ id: "after", type: "get_available_models" }));

			const after = await response;
			expect(after).toMatchObject({ success: true });
			expect(JSON.stringify(after.data).includes('"provider":"openai"')).toBe(configured);
		} finally {
			await handler.dispose();
			harness.cleanup();
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
