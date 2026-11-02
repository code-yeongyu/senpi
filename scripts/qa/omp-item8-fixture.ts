import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { AgentToolResult } from "../../packages/agent/src/types.ts";
import type { ExtensionContext } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import { defaultCodemodeSettings } from "../../packages/senpi-codemode/src/config/settings.ts";
import { createCodemodeSessionManager } from "../../packages/senpi-codemode/src/extension/session-manager.ts";
import {
	createInterpreterDetector,
	getInterpreterAvailability,
} from "../../packages/senpi-codemode/src/interpreters/detect.ts";
import { JavaScriptKernel } from "../../packages/senpi-codemode/src/kernels/js/context-manager.ts";
import { EvalDetachedCellManager } from "../../packages/senpi-codemode/src/tool/detached-cell-manager.ts";
import type { EvalExecutionEventPayload } from "../../packages/senpi-codemode/src/tool/eval-execution-event.ts";
import { createEvalTool } from "../../packages/senpi-codemode/src/tool/eval-tool.ts";
import type { EvalToolDetails } from "../../packages/senpi-codemode/src/tool/types.ts";

export async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("QA event deadline exceeded")), 15_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// Only the admission-failure case overrides the transition. Every execution still uses the real tool/kernel.
class CollisionManager extends EvalDetachedCellManager {
	attempts = 0;
	override detach(): boolean {
		this.attempts++;
		return false;
	}
}

export async function createFixture(collision = false) {
	const sandbox = await mkdtemp(join(tmpdir(), "omp-item8-"));
	const cellStarted = Promise.withResolvers<{ cellId: string; signal: AbortSignal; context: ExtensionContext }>();
	const release = Promise.withResolvers<void>();
	const detached = Promise.withResolvers<void>();
	const settled = Promise.withResolvers<EvalExecutionEventPayload>();
	const foreground = Promise.withResolvers<AgentToolResult<EvalToolDetails>>();
	const events: unknown[] = [];
	const settlements: EvalExecutionEventPayload[] = [];
	const notifications: string[] = [];
	const contexts = new Map<string, ExtensionContext>();
	let activeCellId = "";
	let bridgeFinished = false;
	let bridgeAborts = 0;
	let interrupts = 0;
	let pauses = 0;
	let real: Harness;
	const manager = collision
		? new CollisionManager()
		: new EvalDetachedCellManager({
				onStatusChange(entries) {
					events.push({ event: "detached_status", cells: entries.map((e) => e.cellId) });
					if (entries.length) detached.resolve();
				},
				notifier: {
					notify(cells) {
						notifications.push(...cells.map((cell) => cell.cellId));
					},
				},
			});
	const settings = { ...defaultCodemodeSettings, languages: { js: true, py: true, rb: false, jl: false } };
	const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
	assert(availability.py.detected.ok, "Python is required to prove independent-language admission");
	const kernelManager = await createCodemodeSessionManager({
		sessionId: "omp-item8",
		cwd: sandbox,
		settings,
		availability,
		executeTool: (name, args, options) => real.session.executeTool(name, args, options),
		complete: async () => {
			throw new Error("Paid completion is forbidden in this fixture");
		},
	});
	const kernel = await kernelManager.getKernel("js", () => {});
	assert(kernel instanceof JavaScriptKernel);
	const run = kernel.run.bind(kernel);
	kernel.run = (input) => run({
		...input,
		onMessage: (message) => {
			if (message.type === "status" && message.event.op === "timeout-pause") pauses++;
			input.onMessage?.(message);
		},
	});
	const interrupt = kernel.interrupt.bind(kernel);
	kernel.interrupt = async (reason, cellId) => {
		interrupts++;
		return await interrupt(reason, cellId);
	};
	// Register with the real extension loader, then construct a session owning those registrations.
	real = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.registerTool({
					name: "qa_bridge",
					label: "QA bridge",
					description: "Deferred deterministic bridge",
					parameters: Type.Object({}),
					async execute(_id, _args, signal) {
						assert(signal);
						const context = contexts.get(activeCellId);
						assert(context);
						const aborted = Promise.withResolvers<never>();
						const onAbort = () => {
							bridgeAborts++;
							aborted.reject(signal.reason);
						};
						signal.addEventListener("abort", onAbort, { once: true });
						try {
							events.push({ event: "cellStarted", cellId: activeCellId });
							cellStarted.resolve({ cellId: activeCellId, signal, context });
							await Promise.race([release.promise, aborted.promise]);
							bridgeFinished = true;
							events.push({ event: "bridge_finished" });
							return { content: [{ type: "text", text: "bridge-complete" }], details: { completed: true } };
						} finally {
							signal.removeEventListener("abort", onAbort);
						}
					},
				});
				const tool = createEvalTool({
					enabledLanguages: settings.languages,
					kernelManager,
					cellManager: manager,
					cellTimeoutSeconds: 30,
					executeTool: (name, args, options) => pi.executeTool(name, args, options),
					onCellSettled(payload) {
						settlements.push(payload);
						events.push({ event: "settled", cellId: payload.cellId, ok: payload.ok, detached: payload.detached });
						if (payload.cellId === activeCellId) settled.resolve(payload);
					},
				});
				pi.registerTool({
					...tool,
					async execute(id, args, signal, update, context) {
						contexts.set(id, context);
						if ("code" in args && args.language === "js" && args.code.includes("qa_bridge")) activeCellId = id;
						const result = await tool.execute(id, args, signal, update, context);
						if (id === activeCellId) {
							events.push({ event: "foreground_result", result });
							assert(!("action" in result.details), "foreground bridge execution must return run details");
							foreground.resolve({ ...result, details: result.details });
						}
						return result;
					},
				});
			},
		],
		initialActiveToolNames: ["eval", "qa_bridge"],
	});
	real.getExtensionRunner().setUIContext(undefined, "tui");
	real.session.subscribe((event) => {
		if (event.type === "queue_update")
			events.push({ event: "queue_update", steering: event.steering.length, followUp: event.followUp.length });
	});
	return {
		harness: real,
		kernel,
		manager,
		cellStarted,
		detached,
		settled,
		foreground,
		release,
		events,
		settlements,
		notifications,
		stats: () => ({
			bridgeFinished,
			bridgeAborts,
			interrupts,
			pauses,
			attempts: manager instanceof CollisionManager ? manager.attempts : undefined,
		}),
		async cleanup() {
			release.resolve();
			await manager.dispose();
			await kernelManager.dispose();
			real.cleanup();
			await rm(sandbox, { recursive: true, force: true });
		},
	};
}
