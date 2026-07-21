import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupRoots,
	createHarness,
	dataArray,
	objectAt,
	objectValue,
	responseResult,
	threadIdFromResponse,
} from "./app-server-thread-handlers-harness.ts";

describe("app-server thread metadata handlers", () => {
	afterEach(async () => {
		await cleanupRoots();
	});

	it("merges omitted, null, and trimmed gitInfo fields in the response", async () => {
		// Given: a started persistent thread.
		const { connection, registry, root } = await createHarness();
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 1, method: "thread/start", params: { cwd: root } }),
		);

		// When: metadata is created, then patched with an omitted and a cleared field.
		const created = await registry.dispatch(connection, {
			id: 2,
			method: "thread/metadata/update",
			params: {
				threadId,
				gitInfo: { sha: "  abc123  ", branch: " main ", originUrl: " https://example.test/repo.git " },
			},
		});
		const patched = await registry.dispatch(connection, {
			id: 3,
			method: "thread/metadata/update",
			params: { threadId, gitInfo: { branch: null } },
		});

		// Then: the response contains the merged, trimmed wire metadata.
		expect(objectAt(responseResult(created), "thread").gitInfo).toEqual({
			sha: "abc123",
			branch: "main",
			originUrl: "https://example.test/repo.git",
		});
		expect(objectAt(responseResult(patched), "thread").gitInfo).toEqual({
			sha: "abc123",
			branch: null,
			originUrl: "https://example.test/repo.git",
		});

		const listed = await registry.dispatch(connection, { id: 4, method: "thread/list", params: {} });
		const listedThread = dataArray(responseResult(listed))
			.map(objectValue)
			.find((thread) => thread.id === threadId);
		expect(listedThread?.gitInfo).toEqual({
			sha: "abc123",
			branch: null,
			originUrl: "https://example.test/repo.git",
		});
	});

	it("updates archived threads without loading their runtime", async () => {
		// Given: a thread whose runtime has been archived and unloaded.
		const { connection, registry, root, threads } = await createHarness();
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 10, method: "thread/start", params: { cwd: root } }),
		);
		await registry.dispatch(connection, { id: 11, method: "thread/archive", params: { threadId } });

		// When: metadata is updated while the thread is archived.
		const response = await registry.dispatch(connection, {
			id: 12,
			method: "thread/metadata/update",
			params: { threadId, gitInfo: { branch: " archived " } },
		});

		// Then: the response is storage-only and the archived list sees the same metadata.
		const thread = objectAt(responseResult(response), "thread");
		expect(thread.status).toEqual({ type: "notLoaded" });
		expect(thread.gitInfo).toEqual({ sha: null, branch: "archived", originUrl: null });
		expect(() => threads.getLoadedThread(threadId)).toThrow();
		const listed = await registry.dispatch(connection, {
			id: 13,
			method: "thread/list",
			params: { archived: true },
		});
		const archivedThread = dataArray(responseResult(listed))
			.map(objectValue)
			.find((item) => item.id === threadId);
		expect(archivedThread?.gitInfo).toEqual({ sha: null, branch: "archived", originUrl: null });
	});

	it("rejects an empty replacement with the pinned invalid-request message", async () => {
		// Given: a started persistent thread.
		const { connection, registry, root } = await createHarness();
		const threadId = threadIdFromResponse(
			await registry.dispatch(connection, { id: 20, method: "thread/start", params: { cwd: root } }),
		);

		// When: a whitespace-only branch replacement is supplied.
		const response = await registry.dispatch(connection, {
			id: 21,
			method: "thread/metadata/update",
			params: { threadId, gitInfo: { branch: " \t" } },
		});

		// Then: the request is rejected as invalid rather than silently cleared.
		expect(response).toEqual({
			id: 21,
			error: { code: -32600, message: "gitInfo.branch must not be empty" },
		});
	});
});
