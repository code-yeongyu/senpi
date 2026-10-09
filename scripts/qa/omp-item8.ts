import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "../../packages/ai/src/compat.ts";
import { getUserTexts } from "../../packages/coding-agent/test/suite/harness.ts";
import { toolResultIsError } from "../../packages/senpi-codemode/src/tool/image.ts";
import { bounded, createFixture } from "./omp-item8-fixture.ts";

const request = {
	language: "js",
	code: "const bridge = await tool.qa_bridge({}); globalThis.item8 = 42; return bridge.text",
	summary: "Complete a gated bridge",
} as const;

async function steerDetach() {
	const f = await createFixture();
	f.harness.setResponses([
		fauxAssistantMessage(fauxToolCall("eval", request), { stopReason: "toolUse" }),
		fauxAssistantMessage("steering-consumed"),
	]);
	const turn = f.harness.session.prompt("initial");
	try {
		const started = await bounded(f.cellStarted.promise);
		assert(started.context.steeringSignal);
		let steeringReceipts = 0;
		const steering = Promise.withResolvers<void>();
		started.context.steeringSignal.addEventListener(
			"abort",
			() => {
				steeringReceipts++;
				steering.resolve();
			},
			{ once: true },
		);
		await f.harness.session.steer("queued-steering");
		await bounded(steering.promise);
		await bounded(f.detached.promise);
		const foreground = await bounded(f.foreground.promise);
		assert.equal(foreground.details.cells?.[0]?.status, "detached");
		assert.equal(f.stats().bridgeFinished, false);
		assert.equal(started.signal.aborted, false);
		assert.equal(f.stats().interrupts, 0);
		assert.equal(f.stats().pauses, 1);
		assert.equal(f.kernel.mode, "worker");
		await bounded(turn);
		assert.deepEqual(getUserTexts(f.harness), ["initial", "queued-steering"]);
		assert.deepEqual(f.harness.session.getSteeringMessages(), []);
		const queuedReady = Promise.withResolvers<void>();
		const queued = f.harness.session.executeTool("eval", { ...request, code: "return 9" }, {
			onUpdate: () => queuedReady.resolve(),
		});
		await bounded(queuedReady.promise);
		const waiter = f.manager.liveCells("js", { except: started.cellId })[0];
		assert(waiter);
		assert.equal(waiter.state, "queued");
		assert.deepEqual(waiter.queuedBehind, [started.cellId]);
		await f.manager.stop(waiter.cellId);
		const cancelledQueued = await bounded(queued);
		assert.equal(toolResultIsError(cancelledQueued), true);
		assert.equal(f.manager.liveCells("js")[0]?.cellId, started.cellId);
		const other = await f.harness.session.executeTool("eval", {
			language: "py",
			code: "40 + 2",
			summary: "Independent Python admission",
		});
		assert.equal(toolResultIsError(other), false);
		assert(f.settlements.some((event) => event.language === "py" && event.ok));
		f.release.resolve();
		const settlement = await bounded(f.settled.promise);
		assert.equal(settlement.ok, true);
		assert.equal(settlement.toolAggregates.qa_bridge?.okCount, 1);
		assert.equal(settlement.pendingToolCallCount, 0);
		assert.equal(f.settlements.filter((event) => event.cellId === started.cellId).length, 1);
		await f.manager.flushNotifications();
		assert.deepEqual(f.notifications, [started.cellId]);
		assert.equal(f.stats().interrupts, 0);
		assert.equal(f.stats().bridgeFinished, true);
		assert.equal(f.stats().bridgeAborts, 0);
		assert.deepEqual(f.manager.liveCells("js"), []);
		const state = await f.harness.session.executeTool("eval", { ...request, code: "return globalThis.item8" });
		assert.equal(toolResultIsError(state), false);
		assert(state.content.some((part) => part.type === "text" && part.text.includes("42")));
		return {
			cellId: started.cellId,
			steeringReceipts,
			foreground,
			settlement,
			cancelledQueued,
			other,
			retainedState: state,
			stats: f.stats(),
			events: f.events,
		};
	} finally {
		f.release.resolve();
		await bounded(turn);
		await f.cleanup();
	}
}

async function occupiedSlot() {
	const f = await createFixture(true);
	const execution = f.harness.session.executeTool("eval", request);
	try {
		const started = await bounded(f.cellStarted.promise);
		await f.harness.session.steer("slot-collision");
		assert.equal(f.stats().attempts, 1);
		assert.equal(f.manager.peek(started.cellId).state, "running");
		assert.equal(f.stats().interrupts, 0);
		assert.equal(f.stats().bridgeAborts, 0);
		assert.equal(f.settlements.length, 0);
		f.release.resolve();
		await bounded(execution);
		const settled = await bounded(f.settled.promise);
		assert.equal(settled.ok, true);
		assert.equal(settled.detached, false);
		assert.equal(f.stats().interrupts, 0);
		return { foregroundPreserved: true, settled, stats: f.stats(), events: f.events };
	} finally {
		f.release.resolve();
		await bounded(execution);
		await f.cleanup();
	}
}

async function followUpAndAbort() {
	const f = await createFixture();
	const caller = new AbortController();
	const execution = f.harness.session.executeTool("eval", request, { signal: caller.signal });
	try {
		const started = await bounded(f.cellStarted.promise);
		await f.harness.session.followUp("follow-up-only");
		assert.equal(started.context.steeringSignal?.aborted, false);
		assert.equal(f.manager.peek(started.cellId).state, "running");
		assert.equal(f.stats().pauses, 1);
		await f.harness.session.steer("interrupt-paused-bridge");
		await bounded(f.detached.promise);
		await bounded(f.foreground.promise);
		caller.abort(new Error("caller-owned"));
		caller.abort(new Error("repeated-abort"));
		await f.harness.session.steer("repeated-steering");
		await bounded(execution);
		const settled = await bounded(f.settled.promise);
		assert.equal(settled.ok, false);
		assert.equal(f.stats().interrupts, 1);
		assert.equal(f.stats().bridgeAborts, 1);
		assert.equal(f.stats().bridgeFinished, false);
		assert.equal(f.manager.peek(started.cellId).state, "failed");
		assert.equal(f.settlements.length, 1);
		await f.manager.flushNotifications();
		assert.deepEqual(f.notifications, [started.cellId]);
		// A late successful bridge release cannot overwrite the authoritative cancellation.
		f.release.resolve();
		assert.equal(f.manager.peek(started.cellId).result.details.isError, true);
		f.harness.session.clearQueue();
		const next = await f.harness.session.executeTool("eval", { ...request, code: "return 7" });
		assert.equal(toolResultIsError(next), false);
		assert.equal(f.stats().interrupts, 1);
		return {
			followUpPreserved: true,
			cancellationAuthoritative: true,
			settled,
			next,
			stats: f.stats(),
			events: f.events,
		};
	} finally {
		f.release.resolve();
		await bounded(execution);
		await f.cleanup();
	}
}

const { values } = parseArgs({ options: { case: { type: "string" }, out: { type: "string" } } });
assert(values.out && isAbsolute(values.out), "--out must be an absolute JSON path");
assert(values.case === "steer-detach" || values.case === "occupied-slot-and-abort", "Unknown --case");
const startedAt = new Date().toISOString();
const sourceHashes = Object.fromEntries(
	await Promise.all(
		[
			"packages/senpi-codemode/src/tool/run-eval-cell.ts",
			"packages/senpi-codemode/src/tool/detached-cell-manager.ts",
			"scripts/qa/omp-item8.ts",
			"scripts/qa/omp-item8-fixture.ts",
		].map(async (path) => [
			path,
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
		]),
	),
);
const identity = {
	head: process.env.QA_HEAD,
	tree: process.env.QA_TREE,
	sourceHashes,
	runtime: process.versions,
	paidProviderCalls: 0,
};
await mkdir(dirname(values.out), { recursive: true });
try {
	const results =
		values.case === "steer-detach"
			? await steerDetach()
			: { occupiedSlot: await occupiedSlot(), followUpAndAbort: await followUpAndAbort() };
	await writeFile(
		values.out,
		JSON.stringify(
			{
				case: values.case,
				passed: true,
				startedAt,
				finishedAt: new Date().toISOString(),
				...identity,
				results,
				cleanup: "sessions, kernels, bridge and sandboxes disposed",
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ case: values.case, passed: true, head: identity.head }));
} catch (error) {
	await writeFile(
		values.out,
		JSON.stringify(
			{
				case: values.case,
				passed: false,
				startedAt,
				finishedAt: new Date().toISOString(),
				...identity,
				error:
					error instanceof Error
						? { name: error.name, message: error.message, stack: error.stack }
						: String(error),
			},
			null,
			2,
		),
	);
	throw error;
}
