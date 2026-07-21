import { describe, expect, it } from "vitest";
import { createRegistry } from "../../src/modes/app-server/rpc/registry.ts";
import { registerFuzzyFileSearchMethods } from "../../src/modes/app-server/search/fuzzy-search-methods.ts";
import { FuzzyFileSearchService } from "../../src/modes/app-server/search/fuzzy-search-service.ts";
import type { RouterNotification } from "../../src/modes/app-server/server/notifications.ts";
import {
	deferredCollector,
	deferredVoid,
	fixtureEntry,
	fixtureRanker,
	fuzzyRequest,
	initializedConnection,
} from "./app-server-fuzzy-test-support.ts";

describe("app-server fuzzy file cancellation and sessions", () => {
	it("aborts a tokenless one-shot traversal when the service is disposed", async () => {
		// Given: a tokenless one-shot search blocked in traversal.
		const traversal = deferredCollector();
		const service = new FuzzyFileSearchService({
			broadcast: () => undefined,
			collectEntries: traversal.collect,
			rankEntries: fixtureRanker,
		});
		const search = service.search({ query: "visible", roots: ["/fixture"], cancellationToken: null });
		await traversal.entered;

		// When: runtime teardown disposes the search service before traversal completes.
		service.dispose();
		traversal.release([fixtureEntry("visible.txt")]);

		// Then: the underlying traversal is aborted and cannot return stale results.
		expect(traversal.signal?.aborted).toBe(true);
		expect((await search).files).toEqual([]);
	});

	it("cancels the prior same-token search without stale cleanup losing the replacement", async () => {
		// Given: two in-flight collectors and a third immediate replacement.
		const first = deferredCollector();
		const second = deferredCollector();
		let calls = 0;
		const service = new FuzzyFileSearchService({
			broadcast: () => undefined,
			collectEntries: (roots, signal) => {
				calls += 1;
				if (calls === 1) return first.collect(roots, signal);
				if (calls === 2) return second.collect(roots, signal);
				return Promise.resolve([fixtureEntry("third.txt")]);
			},
			rankEntries: fixtureRanker,
		});

		// When: each newer request reuses the same cancellation token.
		const firstSearch = service.search({ query: "first", roots: ["/fixture"], cancellationToken: "same" });
		await first.entered;
		const secondSearch = service.search({ query: "second", roots: ["/fixture"], cancellationToken: "same" });
		await second.entered;
		first.release([fixtureEntry("first.txt")]);
		await firstSearch;
		const thirdSearch = service.search({ query: "third", roots: ["/fixture"], cancellationToken: "same" });
		second.release([fixtureEntry("second.txt")]);

		// Then: both older signals are aborted and only the live replacement produces a hit.
		expect(first.signal?.aborted).toBe(true);
		expect(second.signal?.aborted).toBe(true);
		expect((await secondSearch).files).toEqual([]);
		expect((await thirdSearch).files.map((file) => file.path)).toEqual(["third.txt"]);
		service.dispose();
	});

	it("rejects invalid session lifecycle requests and treats an unknown stop as a no-op", async () => {
		// Given: registered fuzzy methods and an experimental connection.
		const registry = createRegistry();
		const service = new FuzzyFileSearchService({ broadcast: () => undefined });
		registerFuzzyFileSearchMethods(registry, service);
		const connection = initializedConnection(true);

		// When: empty start, unknown update, and unknown stop requests are dispatched.
		const empty = await registry.dispatch(
			connection,
			fuzzyRequest(1, "fuzzyFileSearch/sessionStart", { sessionId: "", roots: [] }),
		);
		const update = await registry.dispatch(
			connection,
			fuzzyRequest(2, "fuzzyFileSearch/sessionUpdate", { sessionId: "missing", query: "x" }),
		);
		const stop = await registry.dispatch(
			connection,
			fuzzyRequest(3, "fuzzyFileSearch/sessionStop", { sessionId: "missing" }),
		);

		// Then: Codex's invalid-request messages and no-op stop response are preserved.
		expect(empty).toEqual({ id: 1, error: { code: -32600, message: "sessionId must not be empty" } });
		expect(update).toEqual({
			id: 2,
			error: { code: -32600, message: "fuzzy file search session not found: missing" },
		});
		expect(stop).toEqual({ id: 3, result: {} });
		service.dispose();
	});

	it.each([
		{
			method: "fuzzyFileSearch",
			params: null,
			message: "fuzzyFileSearch params must be an object",
		},
		{
			method: "fuzzyFileSearch",
			params: { query: 1, roots: [] },
			message: "fuzzyFileSearch query must be a string",
		},
		{
			method: "fuzzyFileSearch",
			params: { query: "x", roots: [1] },
			message: "fuzzyFileSearch roots must be an array of strings",
		},
		{
			method: "fuzzyFileSearch",
			params: { query: "x", roots: [], cancellationToken: 1 },
			message: "fuzzyFileSearch cancellationToken must be a string or null",
		},
		{
			method: "fuzzyFileSearch/sessionStart",
			params: { sessionId: "session", roots: "not-an-array" },
			message: "fuzzyFileSearch/sessionStart roots must be an array of strings",
		},
		{
			method: "fuzzyFileSearch/sessionUpdate",
			params: { sessionId: "session" },
			message: "fuzzyFileSearch/sessionUpdate query must be a string",
		},
		{
			method: "fuzzyFileSearch/sessionStop",
			params: { sessionId: null },
			message: "fuzzyFileSearch/sessionStop sessionId must be a string",
		},
	])("rejects malformed $method params", async ({ method, params, message }) => {
		// Given: registered fuzzy methods and an initialized experimental connection.
		const registry = createRegistry();
		const service = new FuzzyFileSearchService({ broadcast: () => undefined });
		registerFuzzyFileSearchMethods(registry, service);

		// When: malformed JSON-RPC params cross the request boundary.
		const response = await registry.dispatch(initializedConnection(true), fuzzyRequest(1, method, params));

		// Then: the handler rejects the input as an invalid request without starting work.
		expect(response).toEqual({ id: 1, error: { code: -32600, message } });
		service.dispose();
	});

	it("replaces same-id sessions and emits only the latest query followed by one completion", async () => {
		// Given: a blocked original traversal and a blocked replacement traversal.
		const notifications: RouterNotification[] = [];
		const completed = deferredVoid();
		const first = deferredCollector();
		const replacement = deferredCollector();
		let calls = 0;
		const service = new FuzzyFileSearchService({
			broadcast: (notification) => {
				notifications.push(notification);
				if (notification.method === "fuzzyFileSearch/sessionCompleted") completed.resolve();
			},
			collectEntries: (roots, signal) => {
				calls += 1;
				return calls === 1 ? first.collect(roots, signal) : replacement.collect(roots, signal);
			},
			rankEntries: fixtureRanker,
		});

		// When: the obsolete traversal finishes after replacement, then rapid updates race before replacement completes.
		service.startSession({ sessionId: "session", roots: ["/first"] });
		await first.entered;
		service.startSession({ sessionId: "session", roots: ["/replacement"] });
		await replacement.entered;
		first.release([fixtureEntry("old.txt")]);
		await first.finished;
		for (const query of ["n", "ne", "new", "new-1", "new-2", "new-latest"]) {
			service.updateSession({ sessionId: "session", query });
		}
		replacement.release([fixtureEntry("new.txt")]);
		await completed.promise;

		// Then: stale completion cannot remove the replacement and only the newest query is observable.
		expect(first.signal?.aborted).toBe(true);
		expect(notifications).toEqual([
			{
				method: "fuzzyFileSearch/sessionUpdated",
				params: {
					sessionId: "session",
					query: "new-latest",
					files: [
						{
							root: "/fixture",
							path: "new.txt",
							match_type: "file",
							file_name: "new.txt",
							score: 10,
							indices: [0],
						},
					],
				},
			},
			{ method: "fuzzyFileSearch/sessionCompleted", params: { sessionId: "session" } },
		]);
		service.dispose();
	});

	it("emits a completion after every completed query on the same session", async () => {
		// Given: a loaded session whose first query has fully completed.
		const notifications: RouterNotification[] = [];
		const traversal = deferredCollector();
		const firstCompleted = deferredVoid();
		const secondUpdated = deferredVoid();
		let completedCount = 0;
		let updatedCount = 0;
		const service = new FuzzyFileSearchService({
			broadcast: (notification) => {
				notifications.push(notification);
				if (notification.method === "fuzzyFileSearch/sessionUpdated") {
					updatedCount += 1;
					if (updatedCount === 2) secondUpdated.resolve();
				}
				if (notification.method === "fuzzyFileSearch/sessionCompleted") {
					completedCount += 1;
					if (completedCount === 1) firstCompleted.resolve();
				}
			},
			collectEntries: traversal.collect,
			rankEntries: fixtureRanker,
		});
		service.startSession({ sessionId: "session", roots: ["/fixture"] });
		await traversal.entered;
		service.updateSession({ sessionId: "session", query: "first" });
		traversal.release([fixtureEntry("first.txt"), fixtureEntry("second.txt")]);
		await firstCompleted.promise;

		// When: the same session completes a second edited query.
		service.updateSession({ sessionId: "session", query: "second" });
		await secondUpdated.promise;

		// Then: each latest query has one update followed by its own completion.
		expect(notifications.map((notification) => notification.method)).toEqual([
			"fuzzyFileSearch/sessionUpdated",
			"fuzzyFileSearch/sessionCompleted",
			"fuzzyFileSearch/sessionUpdated",
			"fuzzyFileSearch/sessionCompleted",
		]);
		service.dispose();
	});

	it("suppresses all notifications after a session is stopped", async () => {
		// Given: a session whose traversal is waiting on a barrier.
		const notifications: RouterNotification[] = [];
		const traversal = deferredCollector();
		const service = new FuzzyFileSearchService({
			broadcast: (notification) => notifications.push(notification),
			collectEntries: traversal.collect,
			rankEntries: fixtureRanker,
		});
		service.startSession({ sessionId: "stopped", roots: ["/fixture"] });
		await traversal.entered;

		// When: the session stops before traversal completes.
		service.stopSession({ sessionId: "stopped" });
		traversal.release([fixtureEntry("visible.txt")]);
		await traversal.finished;

		// Then: canceled work cannot emit update or completion notifications.
		expect(traversal.signal?.aborted).toBe(true);
		expect(notifications).toEqual([]);
		service.dispose();
	});
});
