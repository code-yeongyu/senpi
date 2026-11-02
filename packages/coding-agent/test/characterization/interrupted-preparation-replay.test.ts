/**
 * Plan X12 (K4): today's replay of an interrupted preparation on resume. A real child process is SIGKILLed
 * while a tool call is still being prepared (its shim ran, its `tool_call` handler chain has not settled), alone
 * or with a sibling that finished preparation and waits for release. The session is then reopened from disk.
 * Pinned: the interrupted calls are replayed to the provider with their recorded raw arguments and the
 * placeholder result, no shim, handler or body runs again for them, nothing is written for them, and a call the
 * model issues again is prepared and run afresh, exactly once.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import compactionExtension from "../../src/core/extensions/builtin/compaction/index.ts";
import { TOOL_RESULT_PLACEHOLDER } from "../../src/core/extensions/builtin/compaction/repair-tool-pairs.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	PREP_BARRIER_LINE_PREFIX,
	PREP_BARRIER_SCENARIOS,
	PREP_TOOL_NAME,
	type PrepBarrierReport,
	type PrepBarrierScenario,
	type PrepBarrierScenarioName,
	prepBarrierHook,
	prepBarrierTool,
	readTrace,
} from "../fixtures/prep-barrier/prep-barrier.ts";
import { createHarness, type Harness } from "../suite/harness.ts";

const CHILD = join(import.meta.dirname, "../fixtures/prep-barrier/prep-barrier-child.ts");
const BARRIER_TIMEOUT_MS = 20_000;
const REISSUED = { id: "call-again", args: { legacy: "9", label: "again" } } as const;
const roots: string[] = [];
const harnesses: Harness[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
	for (const child of children.splice(0))
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	for (const harness of harnesses.splice(0)) harness.cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function killInsidePreparation(
	name: PrepBarrierScenarioName,
): Promise<{ root: string; report: PrepBarrierReport }> {
	const root = mkdtempSync(join(tmpdir(), "prep-barrier-"));
	roots.push(root);
	const child = spawn("bun", [CHILD, name, root], {
		env: { ...process.env, TMPDIR: root },
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.push(child);
	const exited = new Promise<NodeJS.Signals | null>((resolve) =>
		child.once("exit", (_code, signal) => resolve(signal)),
	);
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const reached = Promise.withResolvers<PrepBarrierReport>();
	if (child.stdout === null) throw new Error("prep-barrier child has no stdout pipe");
	createInterface({ input: child.stdout }).on("line", (line) => {
		if (line.startsWith(PREP_BARRIER_LINE_PREFIX))
			reached.resolve(JSON.parse(line.slice(PREP_BARRIER_LINE_PREFIX.length)));
	});
	void exited.then(() => reached.reject(new Error(`child exited before the barrier: ${stderr}`)));
	const timer = setTimeout(
		() => reached.reject(new Error(`no barrier within ${BARRIER_TIMEOUT_MS}ms: ${stderr}`)),
		BARRIER_TIMEOUT_MS,
	);
	try {
		const report = await reached.promise;
		child.kill("SIGKILL");
		expect(await exited).toBe("SIGKILL");
		return { root, report };
	} finally {
		clearTimeout(timer);
	}
}

function persistedToolResultIds(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const entry: { type?: string; message?: { role?: string; toolCallId?: string } } = JSON.parse(line);
			return entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolCallId
				? [entry.message.toolCallId]
				: [];
		});
}

function preparationTrace(scenario: PrepBarrierScenario): string[] {
	return scenario.calls.flatMap((call) => [`shim:${call.args.label}`, `hook:${call.id}(${call.args.legacy})`]);
}

async function resume(root: string, sessionFile: string, requests: Message[][]): Promise<Harness> {
	const trace = join(root, "trace");
	const harness = await createHarness({
		sessionManager: SessionManager.open(sessionFile),
		cwd: root,
		tools: [prepBarrierTool(trace)],
		settings: { compaction: { enabled: false, speculativeEnabled: false, idleCompactionEnabled: false } },
		extensionFactories: [{ name: "compaction", factory: compactionExtension }, prepBarrierHook(trace)],
	});
	harnesses.push(harness);
	// The CLI's resume restores the reopened branch the same way (createAgentSession, src/core/sdk.ts).
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	await harness.session.bindExtensions({});
	const model = harness.getModel();
	const answer = (message: AssistantMessage) => (context: { messages: Message[] }) => {
		requests.push(context.messages);
		return Object.assign(message, { api: model.api, provider: model.provider, model: model.id });
	};
	harness.setResponses([
		answer(
			fauxAssistantMessage([fauxToolCall(PREP_TOOL_NAME, { ...REISSUED.args }, { id: REISSUED.id })], {
				stopReason: "toolUse",
			}),
		),
		answer(fauxAssistantMessage("resumed")),
	]);
	return harness;
}

describe("X12: today's replay of an interrupted preparation on resume", () => {
	it.each(["handler-chain", "prepared-sibling"] as const)(
		"%s: the interrupted calls replay as recorded with the placeholder result and never prepare again",
		async (name) => {
			const scenario = PREP_BARRIER_SCENARIOS[name];
			const callIds = scenario.calls.map((call) => call.id);

			// Given: the process died inside preparation
			const { root, report } = await killInsidePreparation(name);
			const trace = join(root, "trace");
			expect(report).toMatchObject({ toolCallId: scenario.barrierId, durable: true });
			expect(readTrace(trace)).toEqual(preparationTrace(scenario));
			expect(persistedToolResultIds(report.sessionFile)).toEqual([]);

			// When: the session is reopened and continued
			const requests: Message[][] = [];
			const harness = await resume(root, report.sessionFile, requests);
			await harness.session.prompt("continue after the crash");
			await harness.agent.waitForIdle();

			// Then: the first request replays the interrupted calls with their raw arguments and the placeholder
			expect(requests).toHaveLength(2);
			const replay = requests[0] ?? [];
			const assistantIndex = replay.findIndex(
				(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
			);
			expect(assistantIndex).toBeGreaterThanOrEqual(0);
			const assistant = replay[assistantIndex];
			expect(
				assistant?.role === "assistant"
					? assistant.content.flatMap((block) =>
							block.type === "toolCall" ? [{ id: block.id, arguments: block.arguments }] : [],
						)
					: [],
			).toEqual(scenario.calls.map((call) => ({ id: call.id, arguments: { ...call.args } })));
			expect(replay.slice(assistantIndex + 1, assistantIndex + 1 + callIds.length)).toEqual(
				callIds.map((toolCallId) =>
					expect.objectContaining({
						role: "toolResult",
						toolCallId,
						isError: false,
						content: [{ type: "text", text: TOOL_RESULT_PLACEHOLDER }],
					}),
				),
			);

			// Then: only the re-issued call is prepared and run, once; nothing is written for the interrupted calls
			expect(readTrace(trace)).toEqual([
				...preparationTrace(scenario),
				`shim:${REISSUED.args.label}`,
				`hook:${REISSUED.id}(${REISSUED.args.legacy})`,
				`body:${REISSUED.id}(${REISSUED.args.legacy})`,
			]);
			expect(persistedToolResultIds(report.sessionFile)).toEqual([REISSUED.id]);
		},
	);
});
