import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider, streamSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { AgentSession } from "../../src/core/agent-session.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../utilities.ts";

// A real engine process stopped at exact custody/tool boundaries by its parent.
const [cwd, phase, reopenPath] = process.argv.slice(2);
if (!cwd || !phase) throw new Error("Expected fixture directory and phase");
mkdirSync(cwd, { recursive: true });
const manager = reopenPath ? SessionManager.open(reopenPath) : SessionManager.create(cwd, join(cwd, "sessions"));
const emit = (stage: string, extra: object = {}) =>
	process.stdout.write(`${JSON.stringify({ stage, sessionPath: manager.getSessionFile(), ...extra })}\n`);
const stopped = new Promise<void>(() => {});
const auth = AuthStorage.inMemory();
const faux = registerFauxProvider({});
const model = faux.getModel();
await auth.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
const registry = await createInMemoryModelRegistry(auth);
registry.registerProvider(model.provider, {
	baseUrl: model.baseUrl,
	apiKey: "faux-key",
	api: faux.api,
	models: faux.models.map((item) => ({
		id: item.id,
		name: item.name,
		api: item.api,
		reasoning: item.reasoning,
		input: item.input,
		inputLimits: item.inputLimits,
		cost: item.cost,
		contextWindow: item.contextWindow,
		maxTokens: item.maxTokens,
	})),
});
const resultWritten = Promise.withResolvers<void>();
const done = Promise.withResolvers<void>();
const agent = new Agent({
	initialState: { model, systemPrompt: "Test", tools: [] },
	getApiKey: () => "faux-key",
	streamFn: streamSimple,
	convertToLlm,
});
const session = new AgentSession({
	agent,
	sessionManager: manager,
	settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
	modelRuntime: getModelRuntime(registry),
	resourceLoader: createTestResourceLoader(),
	cwd,
	agentDir: join(cwd, "agent"),
	toolRuntime: "in-process",
	baseToolsOverride: {
		effect: {
			name: "effect",
			label: "Effect",
			description: "Record one test effect",
			parameters: Type.Object({}),
			execute: async () => {
				appendFileSync(join(cwd, "effects"), "effect\n");
				if (phase === "after-effect") {
					emit("checkpoint");
					await stopped;
				}
				return { content: [{ type: "text", text: "effect recorded" }], details: {} };
			},
		},
	},
	sessionStartEvent: {
		type: "session_start",
		reason: reopenPath ? "resume" : "startup",
		attended: phase !== "reopen-unattended",
	},
});
session.subscribe((event) => {
	if (event.type === "session_lifecycle") emit("lifecycle_event", { lifecycle: event.lifecycle });
	if (event.type === "session_lifecycle" && event.lifecycle.state === "done") done.resolve();
	if (event.type === "entry_appended" && event.entry.type === "message" && event.entry.message.role === "toolResult")
		resultWritten.resolve();
});
emit("restoring", { lifecycle: session.lifecycle });
faux.setResponses(
	phase === "after-effect" || phase === "after-result"
		? [
				fauxAssistantMessage([fauxToolCall("effect", {})], { stopReason: "toolUse" }),
				async () => {
					if (phase === "after-result") {
						await resultWritten.promise;
						emit("checkpoint");
						await stopped;
					}
					return fauxAssistantMessage("Effect incorporated.");
				},
			]
		: [
				async () => {
					if (phase === "before-tool") {
						emit("checkpoint");
						await stopped;
					}
					return fauxAssistantMessage("Result incorporated.");
				},
			],
);
const custody = new Map<string, { state: string }>();
for (const entry of manager.getEntries()) {
	if (entry.type !== "custom" || entry.customType !== "work-custody") continue;
	const record = entry.data as { id?: string; state: string };
	if (record.id) custody.set(record.id, record);
}
const queuedOnOpen = [...custody.values()].some((record) => record.state === "queued");
await session.bindExtensions({ mode: "rpc" });
if (reopenPath) {
	if (phase === "reopen" && queuedOnOpen) await done.promise;
	emit("restored", { lifecycle: session.lifecycle, entries: manager.getEntries() });
} else {
	await manager.persistHeaderNow();
	if (phase === "queued")
		manager.persistHeaderNow = async () => {
			emit("checkpoint");
			await stopped;
		};
	const ticket = session.workObligations.open("result:review", "children").ticket();
	await session.sendCustomMessage(
		{ customType: "senpi-task.completion", content: "Review passed.", display: false },
		{ triggerTurn: true, ticket },
	);
	await done.promise;
	emit("sealed", { lifecycle: session.lifecycle, entries: manager.getEntries() });
}
// The parent kills this process at a subscribed checkpoint; no clock drives the test.
process.stdin.resume();
await stopped;
