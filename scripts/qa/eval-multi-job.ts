import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { AgentToolResult } from "../../packages/agent/src/types.ts";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import type {
	EvalDetachedCellNotification,
	EvalDetachedCellSnapshot,
} from "../../packages/senpi-codemode/src/tool/detached-cell-manager.ts";
import type { EvalToolRequest } from "../../packages/senpi-codemode/src/tool/types.ts";

const { values } = parseArgs({
	options: { out: { type: "string" }, "codemode-root": { type: "string" } },
});
const output = resolve(values.out ?? join(process.env.E ?? ".omo/evidence/omp-remaining-adoption-20260921", "task-5/qa.json"));
const sourceRoot = resolve(values["codemode-root"] ?? "packages/senpi-codemode");
// QA-only module boundary: load the same driver against the lane or a read-only baseline.
const { defaultCodemodeSettings }: typeof import("../../packages/senpi-codemode/src/config/settings.ts") =
	await import(pathToFileURL(join(sourceRoot, "src/config/settings.ts")).href);
const { createCodemodeSessionManager }: typeof import("../../packages/senpi-codemode/src/extension/session-manager.ts") =
	await import(pathToFileURL(join(sourceRoot, "src/extension/session-manager.ts")).href);
const { createInterpreterDetector, getInterpreterAvailability }: typeof import("../../packages/senpi-codemode/src/interpreters/detect.ts") =
	await import(pathToFileURL(join(sourceRoot, "src/interpreters/detect.ts")).href);
const { EvalDetachedCellManager }: typeof import("../../packages/senpi-codemode/src/tool/detached-cell-manager.ts") =
	await import(pathToFileURL(join(sourceRoot, "src/tool/detached-cell-manager.ts")).href);
const { createEvalTool }: typeof import("../../packages/senpi-codemode/src/tool/eval-tool.ts") =
	await import(pathToFileURL(join(sourceRoot, "src/tool/eval-tool.ts")).href);

async function bounded<T>(promise: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("QA event deadline exceeded")), 30_000);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function text(result: AgentToolResult<unknown>): string {
	return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

const checks: { name: string; pass: boolean; observed: unknown }[] = [];
function check(name: string, pass: boolean, observed: unknown): void {
	checks.push({ name, pass, observed });
	assert(pass, `${name}: ${JSON.stringify(observed)}`);
}

const transcript: { request: unknown; response?: unknown; error?: string }[] = [];
const notifications: EvalDetachedCellNotification[] = [];
const subscribed = new Map<string, () => void>();
const sandbox = await mkdtemp(join(tmpdir(), "eval-multi-job-"));
const aRelease = join(sandbox, "a.release");
const cRelease = join(sandbox, "c.release");
const settings = {
	...defaultCodemodeSettings,
	cellTimeoutSeconds: 2,
	languages: { js: true, py: true, rb: false, jl: false },
};
let harness: Harness | undefined;
let failure: unknown;
let cleanup: unknown;
const manager = new EvalDetachedCellManager({
	maxDetachedCells: settings.maxDetachedCells,
	notifier: {
		notify(batch) {
			notifications.push(...batch);
			for (const notice of batch) subscribed.get(notice.cellId)?.();
		},
	},
});
let kernels: Awaited<ReturnType<typeof createCodemodeSessionManager>> | undefined;
let bridgePort: number | undefined;
let executionMode: string | undefined;
const startedAt = new Date().toISOString();
try {
	const availability = await getInterpreterAvailability(settings, createInterpreterDetector());
	assert(availability.py.detected.ok, "Python is required");
	kernels = await createCodemodeSessionManager({
		sessionId: "eval-multi-job",
		cwd: sandbox,
		settings,
		availability,
		executeTool: async () => { throw new Error("No host tools are used by this scenario"); },
		complete: async () => { throw new Error("No provider calls are allowed"); },
	});
	const kernelManager = kernels;
	bridgePort = kernelManager.bridgeEndpoint?.().port;
	harness = await createHarness({
		extensionFactories: [(pi) => {
			const tool = createEvalTool({
				enabledLanguages: settings.languages,
				settings,
				kernelManager,
				cellManager: manager,
				cellTimeoutSeconds: settings.cellTimeoutSeconds,
				executeTool: (name, args, options) => pi.executeTool(name, args, options),
			});
			executionMode = tool.executionMode;
			pi.registerTool(tool);
		}],
		initialActiveToolNames: ["eval"],
	});
	harness.getExtensionRunner().setUIContext(undefined, "tui");
	check("sequential tool with two-second detach threshold", executionMode === "sequential" && settings.cellTimeoutSeconds === 2,
		{ executionMode, cellTimeoutSeconds: settings.cellTimeoutSeconds });
	const session = harness.session;
	async function request(input: EvalToolRequest) {
		const pair: (typeof transcript)[number] = { request: input };
		transcript.push(pair);
		try {
			const response = await bounded(session.executeTool("eval", input));
			pair.response = response;
			return response;
		} catch (error) {
			pair.error = error instanceof Error ? error.message : String(error);
			throw error;
		}
	}
	const a = await request({
		language: "js", summary: "A waits for external release",
		code: `globalThis.row5BRan = false; while (!(await Bun.file(${JSON.stringify(aRelease)}).exists())) { await Bun.sleep(50); } console.log(JSON.stringify({ bRan: globalThis.row5BRan }));`,
	});
	check("A detaches while its barrier stays closed", text(a).includes("detached") && !existsSync(aRelease), a);
	const aId = /Eval cell (\S+)/u.exec(text(a))?.[1];
	assert(aId, "A cell id missing");
	const b = await request({
		language: "js", summary: "B must queue without executing",
		code: "globalThis.row5BRan = true; 1 + 1",
	});
	check("B detaches queued behind A", text(b).includes(`queued behind ${aId}`) && text(b).includes("detached"), b);
	const bId = /Eval cell (\S+)/u.exec(text(b))?.[1];
	assert(bId, "B cell id missing");
	const c = await request({
		language: "py", summary: "C waits independently for external release",
		code: `import os, asyncio\nwhile not os.path.exists(${JSON.stringify(cRelease)}):\n    await asyncio.sleep(0.05)\nprint("C released")`,
	});
	check("C detaches independently", text(c).includes("detached") && !existsSync(cRelease), c);
	const cId = /Eval cell (\S+)/u.exec(text(c))?.[1];
	assert(cId, "C cell id missing");
	const listed = await request({ action: "list" });
	const live = manager.liveCells();
	check("list exposes all three live cells with B behind A", live.length === 3 &&
		live.every((cell) => cell.state === "detached") &&
		live.find((cell) => cell.cellId === bId)?.queuedBehind?.[0] === aId &&
		[aId, bId, cId].every((id) => text(listed).includes(id)) &&
		text(listed).includes(`queued behind ${aId}`), listed);
	const stopped = await request({ action: "stop", cell_id: bId });
	check("stop B cancels only B", manager.peek(bId).state === "cancelled" &&
		manager.peek(aId).state === "detached" && text(stopped).includes("cancelled"), stopped);
	const reset = await request({ language: "js", code: "1", summary: "Refuse reset while A is live", reset: true });
	check("reset refuses with the typed code and A id", JSON.stringify(reset).includes("eval_kernel_busy_reset_refused") &&
		text(reset).includes(aId) && manager.peek(aId).state === "detached", reset);
	// Subscribe to the exact completion ids BEFORE releasing either external barrier.
	const completion = [aId, cId].map((id) => {
		const event = Promise.withResolvers<void>();
		subscribed.set(id, event.resolve);
		return event.promise;
	});
	const releasePair: (typeof transcript)[number] = { request: { release: ["a.release", "c.release"] } };
	transcript.push(releasePair);
	await Promise.all([writeFile(aRelease, ""), writeFile(cRelease, "")]);
	releasePair.response = { aReleased: existsSync(aRelease), cReleased: existsSync(cRelease) };
	await bounded(Promise.all(completion));
	await manager.flushNotifications();
	check("exactly A and C complete, plus B cancellation", notifications.length === 3 &&
		[aId, cId].every((id) => notifications.filter((notice) => notice.cellId === id && notice.content.includes("completed")).length === 1) &&
		notifications.filter((notice) => notice.cellId === bId && notice.content.includes("cancelled")).length === 1,
		notifications);
	const aDone: EvalDetachedCellSnapshot = manager.peek(aId);
	check("A completion proves B never executed", aDone.state === "completed" &&
		text(aDone.result).includes('{"bRan":false}'), aDone.result);
	check("C completes and no cells remain live", manager.peek(cId).state === "completed" &&
		manager.liveCells().length === 0, manager.list());
	const retained = await request({ language: "js", summary: "Verify persistent B sentinel after drain", code: "console.log(globalThis.row5BRan)" });
	check("B sentinel stays false after the queue drains", text(retained).trim() === "false", retained);
} catch (error) {
	failure = error;
} finally {
	await Promise.all([writeFile(aRelease, ""), writeFile(cRelease, "")]);
	await manager.dispose();
	await kernels?.dispose();
	const harnessDir = harness?.tempDir;
	harness?.cleanup();
	await rm(sandbox, { recursive: true, force: true });
	let bridgeClosed = bridgePort === undefined;
	if (bridgePort !== undefined) {
		const port = bridgePort;
		bridgeClosed = await bounded(new Promise<boolean>((resolveClosed, reject) => {
			const socket = createConnection({ host: "127.0.0.1", port });
			socket.once("connect", () => { socket.destroy(); resolveClosed(false); });
			socket.once("error", (error: NodeJS.ErrnoException) => {
				socket.destroy();
				if (error.code === "ECONNREFUSED") resolveClosed(true);
				else reject(error);
			});
		}));
	}
	const pass = !existsSync(sandbox) && (harnessDir === undefined || !existsSync(harnessDir)) && bridgeClosed;
	cleanup = { pass, sandboxRemoved: !existsSync(sandbox), sessionRemoved: harnessDir === undefined || !existsSync(harnessDir), bridgeClosed, kernelsDisposed: true };
	checks.push({ name: "cleanup", pass, observed: cleanup });
	await mkdir(dirname(output), { recursive: true });
	await writeFile(output, JSON.stringify({
		pass: failure === undefined && checks.every((entry) => entry.pass),
		startedAt, sourceRoot, executionMode, cellTimeoutSeconds: settings.cellTimeoutSeconds,
		paidProviderCalls: 0, transcript, notifications, checks, cleanup,
		...(failure === undefined ? {} : { error: failure instanceof Error ? failure.message : String(failure) }),
	}, null, 2));
}
if (failure !== undefined) throw failure;
assert(checks.every((entry) => entry.pass), "QA cleanup failed");
console.log(JSON.stringify({ pass: true, output, checks: checks.length }));
