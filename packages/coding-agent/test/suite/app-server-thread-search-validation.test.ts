import { afterEach, describe, expect, it } from "vitest";
import { cleanupRoots, createHarness, dataArray, responseResult } from "./app-server-thread-handlers-harness.ts";
import { writeSearchSession } from "./app-server-thread-search-support.ts";

describe("app-server thread/search validation", () => {
	afterEach(async () => {
		await cleanupRoots();
	});

	it("excludes app-server sessions when sourceKinds is omitted or empty", async () => {
		// Given: one persisted Senpi app-server session matching the search term.
		const { connection, registry, root } = await createHarness();
		await writeSearchSession(root, "21000000-0000-4000-8000-000000000001", "default source needle");

		// When: search uses the Codex default, an empty filter, and an explicit appServer filter.
		const omitted = await registry.dispatch(connection, {
			id: 30,
			method: "thread/search",
			params: { searchTerm: "default source needle" },
		});
		const empty = await registry.dispatch(connection, {
			id: 31,
			method: "thread/search",
			params: { searchTerm: "default source needle", sourceKinds: [] },
		});
		const explicit = await registry.dispatch(connection, {
			id: 32,
			method: "thread/search",
			params: { searchTerm: "default source needle", sourceKinds: ["appServer"] },
		});

		// Then: interactive defaults exclude appServer while an explicit filter includes it.
		expect(dataArray(responseResult(omitted))).toHaveLength(0);
		expect(dataArray(responseResult(empty))).toHaveLength(0);
		expect(dataArray(responseResult(explicit))).toHaveLength(1);
	});

	it.each([
		["negative limit", { limit: -1 }],
		["fractional limit", { limit: 1.5 }],
		["overflowing limit", { limit: 0x1_0000_0000 }],
		["string archived flag", { archived: "true" }],
		["numeric archived flag", { archived: 1 }],
	] as const)("rejects a malformed %s", async (_label, malformed) => {
		// Given: one persisted session and otherwise valid search parameters.
		const { connection, registry, root } = await createHarness();
		await writeSearchSession(root, "22000000-0000-4000-8000-000000000001", "malformed needle");

		// When: one malformed wire value crosses the thread/search boundary.
		const response = await registry.dispatch(connection, {
			id: 33,
			method: "thread/search",
			params: { searchTerm: "malformed needle", sourceKinds: ["appServer"], ...malformed },
		});

		// Then: malformed Option<u32>/Option<bool> values are rejected rather than coerced.
		expect(response).toMatchObject({ id: 33, error: { code: -32600 } });
	});
});
