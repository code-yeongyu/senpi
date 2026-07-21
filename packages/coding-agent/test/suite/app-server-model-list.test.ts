import { describe, expect, it } from "vitest";
import type { ModelListResponse } from "../../src/modes/app-server/protocol/models.ts";
import { buildModelListResponse } from "../../src/modes/app-server/server/models.ts";
import { ServerCore } from "../../src/modes/app-server/server/server-core.ts";
import { createHarness } from "./harness.ts";

describe("app-server model/list pagination", () => {
	it("paginates visible models with numeric cursors, clamps zero limits, and rejects invalid wire params", async () => {
		// Given: three available models and one model hidden from the default picker.
		const harness = await createHarness({
			models: [
				{ id: "first", name: "First", reasoning: true, input: ["text"] },
				{ id: "second", name: "Second", reasoning: true, input: ["text"] },
				{ id: "third", name: "Third", reasoning: true, input: ["text"] },
			],
		});
		try {
			const available = harness.session.modelRegistry.getAvailable();
			const first = available[0];
			if (!first) throw new Error("model fixture did not register");
			const hidden = { ...first, id: "hidden", name: "Hidden", hidden: true };
			const models = [first, hidden, ...available.slice(1)];

			// When: the client requests pages and a zero-sized page.
			const firstPage: ModelListResponse = buildModelListResponse(models, {
				cursor: null,
				limit: 1,
				includeHidden: false,
			});
			const secondPage = buildModelListResponse(models, {
				cursor: firstPage.nextCursor,
				limit: 1,
				includeHidden: false,
			});
			const clampedPage = buildModelListResponse(models, { limit: 0, includeHidden: false });
			const hiddenPage = buildModelListResponse(models, { limit: 10, includeHidden: true });

			// Then: cursors are numeric offsets, zero becomes one, and hidden models are opt-in.
			expect(firstPage.data.map((model) => model.model)).toEqual(["first"]);
			expect(firstPage.nextCursor).toBe("1");
			expect(secondPage.data.map((model) => model.model)).toEqual(["second"]);
			expect(clampedPage.data).toHaveLength(1);
			expect(hiddenPage.data.some((model) => model.hidden && model.model === "hidden")).toBe(true);
			for (const model of hiddenPage.data) {
				expect(model.serviceTiers).toEqual([]);
				expect(model.defaultServiceTier).toBeNull();
			}

			const sent: unknown[] = [];
			const core = new ServerCore({
				modelRegistry: { getAvailable: () => models },
				version: "test",
				codexHome: harness.tempDir,
			});
			const connection = core.addConnection({
				id: "model-list-validation",
				transportKind: "stdio",
				send: (message) => {
					sent.push(message);
				},
				close: () => undefined,
			});
			await core.receive(connection.id, {
				kind: "request",
				message: {
					id: 1,
					method: "initialize",
					params: {
						clientInfo: { name: "test", title: "Test", version: "0" },
						capabilities: { experimentalApi: false, requestAttestation: false },
					},
				},
			});

			// Invalid wire types must not be normalized into valid model-list requests.
			await core.receive(connection.id, {
				kind: "request",
				message: { id: 2, method: "model/list", params: { limit: -1 } },
			});
			await core.receive(connection.id, {
				kind: "request",
				message: { id: 3, method: "model/list", params: { includeHidden: "true" } },
			});
			expect(sent.slice(1)).toEqual([
				{ id: 2, error: { code: -32600, message: "model/list received an invalid limit" } },
				{ id: 3, error: { code: -32600, message: "model/list received an invalid includeHidden" } },
			]);
		} finally {
			harness.cleanup();
		}
	});
});
