import { afterEach, describe, expect, it } from "vitest";
import {
	PREP_CASES,
	type PrepCaseAdapters,
	type PrepFixture,
	type PrepFixtureOptions,
} from "../../../agent/src/execution/testing/prep-cases.ts";
import type { ExtensionFactory } from "../../src/index.ts";
import { resultText, sessionExecutor } from "../execution/executor-harness.ts";
import { createQaToolFixture } from "../fixtures/qa-tool/qa-tool-fixture.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

// F03 + G1 on the prepared executor: the inactive `qa` tool is activated lazily after effect_possible is durable,
// joins the active set, and the G1 order runs once. PREP-01..04 run against the same session pipeline.
const ORDER_ONCE = ["activate", "shim", "hook1", "pre", "hook2", "body(42)"];

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function lastHandler(options: PrepFixtureOptions): ExtensionFactory {
	return (pi) => {
		pi.on("tool_call", (event) => {
			if (options.rewrite !== undefined) {
				const input: Record<string, unknown> = event.input;
				for (const key of Object.keys(input)) delete input[key];
				Object.assign(input, options.rewrite);
			}
			return options.block === undefined ? undefined : { block: true, reason: options.block };
		});
	};
}

async function openQaExecutor(options: PrepFixtureOptions = {}): Promise<PrepFixture & { harness: Harness }> {
	const fixture = createQaToolFixture();
	const harness = await createHarness({ extensionFactories: [...fixture.extensionFactories, lastHandler(options)] });
	cleanups.push(() => {
		harness.cleanup();
		fixture.cleanup();
	});
	fixture.trustPreToolUseHook(harness.tempDir);
	harness.session.setActiveToolsByName(["read"]);
	let effectAt: number | undefined;
	const executor = await sessionExecutor(harness.session, () => {
		effectAt = fixture.readTrace().length;
	});
	return {
		harness,
		handlerSteps: ["hook1", "pre", "hook2"],
		prepare: async (id, args) => {
			const reply = await executor.prepare(id, "qa", args);
			if (reply.kind === "prepared") return { kind: "prepared", call: reply.call };
			if (reply.kind === "refused") return reply;
			return { kind: "blocked", reason: resultText(reply.result) };
		},
		release: async (id) => {
			const reply = await executor.release(id);
			if (reply.kind === "settled")
				return { kind: "settled", text: resultText(reply.result), isError: reply.isError };
			return reply.kind === "replayed" ? { kind: "replayed" } : reply;
		},
		trace: () => {
			const trace = fixture.readTrace();
			return effectAt === undefined ? trace : [...trace.slice(0, effectAt), "effect", ...trace.slice(effectAt)];
		},
		row: executor.row,
		restart: executor.restart,
	};
}

describe("F03 / G1: lazy activation and order once on the prepared executor", () => {
	it("activates the inactive tool after effect_possible and runs the G1 order once", async () => {
		// Given
		const qa = await openQaExecutor();
		expect(qa.harness.session.getActiveToolNames()).not.toContain("qa");

		// When
		const prepared = await qa.prepare("f03", { legacy: "42" });
		const released = await qa.release("f03");

		// Then
		expect(prepared.kind).toBe("prepared");
		expect(qa.harness.session.getActiveToolNames()).toContain("qa");
		expect(released).toEqual({ kind: "settled", text: "qa:42", isError: false });
		expect(qa.trace()).toEqual(["effect", ...ORDER_ONCE]);
		expect(qa.harness.session.messages).toEqual([]);
	});
});

describe("a batch_abort preparation survives an executor restart", () => {
	it("returns the stored batch_abort reply to a prepare re-sent after restart", async () => {
		// Given: a tool_call handler that aborts the batch during preflight
		const abort = new AbortController();
		const fixture = createQaToolFixture();
		const aborting: ExtensionFactory = (pi) => {
			pi.on("tool_call", () => abort.abort());
		};
		const harness = await createHarness({ extensionFactories: [...fixture.extensionFactories, aborting] });
		cleanups.push(() => {
			harness.cleanup();
			fixture.cleanup();
		});
		fixture.trustPreToolUseHook(harness.tempDir);
		const executor = await sessionExecutor(harness.session);
		const first = await executor.prepare("abort", "qa", { legacy: "42" }, abort.signal);

		// When
		await executor.restart();
		const resent = await executor.prepare("abort", "qa", { legacy: "42" });

		// Then
		expect(first.kind).toBe("batch_abort");
		expect(resent).toEqual(first);
		expect(fixture.readTrace()).toEqual(["activate", "shim", "hook1", "pre", "hook2"]);
	});
});

describe("PREP-01..05 on the session's preparation pipeline", () => {
	const adapters: PrepCaseAdapters = { executor: { open: openQaExecutor } };
	for (const [id, run] of PREP_CASES) {
		it(id, async () => {
			await run(adapters);
		});
	}
});
