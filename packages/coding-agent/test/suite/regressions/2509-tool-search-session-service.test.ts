// Regression: senpi#2509. Closing one in-process session must not break another session's tool search.

import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	deriveExtensionRegistrationId,
	emitActivationMarker,
} from "../../../src/core/extensions/builtin/tool-search/engine/marker.ts";
import toolSearchExtension from "../../../src/core/extensions/builtin/tool-search/index.ts";
import {
	getToolSearchService,
	getToolSearchServiceForExtension,
	type ToolSearchService,
} from "../../../src/core/extensions/builtin/tool-search/service.ts";
import type { ResourceLoader } from "../../../src/core/resource-loader.ts";
import type { ExtensionAPI, ExtensionError, LoadExtensionsResult, ToolDefinition } from "../../../src/index.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const NATIVE_TOOL_SEARCH = "tool_search_tool_bm25";

function deferredTool(name: string): ToolDefinition {
	return {
		name,
		label: name,
		description: `${name} looks up stored records`,
		exposure: "search",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: `${name}-ran` }], details: {} }),
	};
}

interface OpenSession extends Harness {
	registerLateTool(name: string): void;
}

function extensionLoad(
	owner: string,
	tools: readonly string[],
	onLoad: (pi: ExtensionAPI) => void,
): Promise<LoadExtensionsResult> {
	return createTestExtensionsResult([
		{ path: "<builtin:tool-search>", factory: toolSearchExtension },
		{
			path: owner,
			factory: (pi) => {
				for (const name of tools) pi.registerTool(deferredTool(name));
				onLoad(pi);
			},
		},
	]);
}

function reloadableLoader(initial: LoadExtensionsResult, next: () => Promise<LoadExtensionsResult>): ResourceLoader {
	let current = initial;
	return {
		...createTestResourceLoader(),
		getExtensions: () => current,
		reload: async () => {
			current = await next();
		},
	};
}

const open = new Set<Harness>();

async function openSession(owner: string, generations: readonly (readonly string[])[]): Promise<OpenSession> {
	let generation = 0;
	let currentPi: ExtensionAPI | undefined;
	const load = () =>
		extensionLoad(owner, generations[Math.min(generation++, generations.length - 1)], (pi) => {
			currentPi = pi;
		});
	const harness = await createHarness({ resourceLoader: reloadableLoader(await load(), load) });
	open.add(harness);
	await harness.getExtensionRunner().emit({ type: "session_start", reason: "startup" });
	return Object.assign(harness, {
		registerLateTool: (name: string) => currentPi?.registerTool(deferredTool(name)),
	});
}

function close(harness: Harness): void {
	open.delete(harness);
	harness.cleanup();
}

async function runChildSession(): Promise<void> {
	close(await openSession("/extensions/child.ts", [["child_lookup"]]));
}

function recordErrors(harness: Harness): ExtensionError[] {
	const errors: ExtensionError[] = [];
	harness.getExtensionRunner().onError((error) => errors.push(error));
	return errors;
}

function activationHistory(harness: Harness, name: string): unknown[] {
	const tool = harness.session.getAllTools().find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`${name} is not registered`);
	const registrationId = deriveExtensionRegistrationId(tool.sourceInfo, name);
	return [
		{
			role: "user",
			content: [{ type: "text", text: emitActivationMarker([{ name, registrationId }]) }],
			timestamp: 0,
		},
	];
}

async function sendRequest(harness: Harness, history: unknown[]): Promise<string> {
	const runner = harness.getExtensionRunner();
	await runner.emitContext(history as Parameters<typeof runner.emitContext>[0]);
	const payload = await runner.emitBeforeProviderRequest(
		{ model: "claude-fable-5-1", tools: [], messages: [] },
		undefined,
		{ model: getModel("anthropic", "claude-fable-5-1"), headers: {} },
	);
	return JSON.stringify(payload);
}

afterEach(() => {
	for (const harness of [...open]) close(harness);
});

describe("senpi#2509: every session owns its tool-search service", () => {
	it("keeps a reloaded session's tool search working after an in-process child session closes", async () => {
		// Given: a session reloads into a generation that adds a deferred tool, then runs a child session.
		const session = await openSession("/extensions/parent.ts", [
			["parent_lookup", "parent_archive"],
			["parent_lookup", "parent_archive", "parent_reloaded"],
		]);
		await session.session.reload();
		await session.getExtensionRunner().emit({ type: "session_start", reason: "reload" });
		await runChildSession();
		const errors = recordErrors(session);

		// When: a deferred tool registers late, and the next request carries history that activated it.
		session.registerLateTool("parent_late");
		const payload = await sendRequest(session, activationHistory(session, "parent_late"));

		// Then: the refreshed catalog rehydrates that tool, native tool search is injected, nothing is stale.
		expect(errors).toEqual([]);
		expect(session.session.getActiveToolNames()).toContain("parent_late");
		expect(session.session.getAllTools().map(({ name }) => name)).toContain("parent_reloaded");
		expect(session.session.getActiveToolNames()).not.toContain("parent_archive");
		expect(payload).toContain(NATIVE_TOOL_SEARCH);
	});

	it("gives a replacement session working tool search after the old session and a child close", async () => {
		// Given: a session is replaced (the new one opens, the old one closes), then the new one runs a child.
		const old = await openSession("/extensions/old.ts", [["old_lookup", "old_archive"]]);
		const next = await openSession("/extensions/next.ts", [["next_lookup", "next_archive"]]);
		close(old);
		await runChildSession();
		const errors = recordErrors(next);

		// When: a deferred tool registers late, and the next request carries history that activated it.
		next.registerLateTool("next_late");
		const payload = await sendRequest(next, activationHistory(next, "next_late"));

		// Then: its own catalog answers, with no trace of the closed sessions.
		expect(errors).toEqual([]);
		expect(next.session.getActiveToolNames()).toContain("next_late");
		expect(next.session.getActiveToolNames()).not.toContain("next_archive");
		expect(payload).toContain(NATIVE_TOOL_SEARCH);
		expect(payload).not.toContain("old_");
		expect(payload).not.toContain("child_");
	});

	it("fails loudly, naming the session, when a closed session's service is used", async () => {
		// Given: a caller resolved the only live session's service, then that session was replaced.
		const old = await openSession("/extensions/old.ts", [["old_lookup"]]);
		const oldService = getToolSearchService();
		const oldSessionId = old.session.sessionId;
		const next = await openSession("/extensions/next.ts", [["next_lookup"]]);
		close(old);

		// When / Then: every read and activation through the retired service throws, never a stale or empty catalog.
		const disposed = new RegExp(`tool-search service of session ${oldSessionId} is disposed`);
		expect(() => oldService.getCatalog()).toThrow(disposed);
		expect(() => oldService.search("lookup")).toThrow(disposed);
		expect(() => oldService.activateTool("next_lookup")).toThrow(disposed);
		expect(() => oldService.maybeRehydrateFromHistory(activationHistory(next, "next_lookup"))).toThrow(disposed);
		expect(next.session.getActiveToolNames()).not.toContain("next_lookup");
	});

	it("releases the adopted service when session construction fails after adopting it", async () => {
		// Given: an untyped extension whose tool metadata breaks the tool registry build after adoption.
		let abandoned: ToolSearchService | undefined;
		const broken = await createTestExtensionsResult([
			{ path: "<builtin:tool-search>", factory: toolSearchExtension },
			{
				path: "/extensions/broken.ts",
				factory: (pi) => {
					abandoned = getToolSearchServiceForExtension(pi);
					pi.registerTool({ ...deferredTool("broken_lookup"), promptGuidelines: [42 as unknown as string] });
				},
			},
		]);

		// When: the session constructor throws, and a healthy session opens afterwards.
		await expect(
			createHarness({ resourceLoader: createTestResourceLoader({ extensionsResult: broken }) }),
		).rejects.toThrow();
		const live = await openSession("/extensions/live.ts", [["live_lookup"]]);

		// Then: the failed session's service is retired and no longer counts as a live session.
		expect(abandoned).toBeDefined();
		expect(() => abandoned?.getCatalog()).toThrow(/is disposed \(session construction failed\)/);
		expect(
			getToolSearchService()
				.getCatalog()
				.map(({ name }) => name),
		).toContain("live_lookup");
		expect(live.session.getAllTools().map(({ name }) => name)).toContain("live_lookup");
	});
});
