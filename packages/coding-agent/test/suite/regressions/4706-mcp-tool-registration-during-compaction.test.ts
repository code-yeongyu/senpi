import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { registerToolsPreservingActiveSet } from "../../../src/core/extensions/builtin/mcp/active-set.ts";
import type { ExtensionAPI } from "../../../src/core/extensions/index.ts";
import { createHarness, type Harness } from "../harness.ts";

type Deferred = {
	readonly promise: Promise<void>;
	readonly resolve: () => void;
};

function createDeferred(): Deferred {
	let resolve: (() => void) | undefined;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	if (!resolve) throw new Error("Deferred resolver was not initialized");
	return { promise, resolve };
}

function serverTool(name: string) {
	return {
		name,
		label: name,
		description: `${name} from an MCP server that finished connecting`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: name }], details: {} }),
	};
}

function compactionEntryCount(harness: Harness): number {
	return harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
}

interface InFlightCompaction {
	readonly harness: Harness;
	readonly pi: ExtensionAPI;
	readonly compaction: Promise<unknown>;
	readonly release: () => void;
}

/**
 * Start a manual compaction and hold it inside summary generation, the window in
 * which a just-started session's MCP servers finish connecting.
 */
async function startHeldManualCompaction(
	harnesses: Harness[],
	preCompaction?: (pi: ExtensionAPI) => void,
): Promise<InFlightCompaction> {
	const generationStarted = createDeferred();
	const releaseGeneration = createDeferred();
	let captured: ExtensionAPI | undefined;
	const harness = await createHarness({
		models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 64 }],
		settings: { compaction: { enabled: true, reserveTokens: 16_384, keepRecentTokens: 1 } },
		extensionFactories: [
			(pi: ExtensionAPI) => {
				captured = pi;
			},
		],
	});
	harnesses.push(harness);
	harness.setResponses([
		fauxAssistantMessage("initial assistant"),
		async () => {
			generationStarted.resolve();
			await releaseGeneration.promise;
			return fauxAssistantMessage("summary generated while MCP servers connected");
		},
	]);
	await harness.session.prompt("initial prompt ".repeat(40));
	if (!captured) throw new Error("Expected the extension API to be captured");
	preCompaction?.(captured);

	const compaction = harness.session.compact();
	await generationStarted.promise;
	return { harness, pi: captured, compaction, release: releaseGeneration.resolve };
}

describe("Regression #4706: MCP tool registration during a manual compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("commits on the first try when MCP servers register their tools mid-compaction", async () => {
		const { harness, pi, compaction, release } = await startHeldManualCompaction(harnesses);
		const activeAtStart = harness.session.getActiveToolNames();

		// A direct-mode server: its whole catalog registers and stays active.
		registerToolsPreservingActiveSet(
			pi,
			[serverTool("mcp__direct__lookup"), serverTool("mcp__direct__fetch")],
			[...pi.getActiveTools(), "mcp__direct__lookup", "mcp__direct__fetch"],
		);
		// A search-mode server: its full catalog registers (each registration briefly
		// activates the tool), then only its direct tool stays active.
		registerToolsPreservingActiveSet(
			pi,
			[serverTool("mcp__search__pinned"), serverTool("mcp__search__deferred")],
			[...pi.getActiveTools(), "mcp__search__pinned"],
		);
		release();

		await expect(compaction).resolves.toBeDefined();
		expect(compactionEntryCount(harness)).toBe(1);
		expect(harness.eventsOfType("compaction_end").filter((event) => event.aborted)).toHaveLength(0);
		expect(harness.session.getActiveToolNames()).toEqual(
			expect.arrayContaining([...activeAtStart, "mcp__direct__lookup", "mcp__direct__fetch", "mcp__search__pinned"]),
		);
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__search__deferred");
	});

	it("still cancels the compaction when a tool active at its start is revoked", async () => {
		const { harness, pi, compaction, release } = await startHeldManualCompaction(harnesses, (api) => {
			api.registerTool(serverTool("mcp__revoked__tool"));
		});
		expect(harness.session.getActiveToolNames()).toContain("mcp__revoked__tool");

		pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "mcp__revoked__tool"));
		release();

		await expect(compaction).rejects.toThrow();
		expect(compactionEntryCount(harness)).toBe(0);
	});
});
