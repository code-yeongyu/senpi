import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	type AgentCheckpoint,
	captureAgentCheckpoint,
	getLatestCheckpoint,
	injectRestorationDirective,
	persistCheckpoint,
} from "../../src/core/extensions/builtin/compaction/checkpoint-state.js";
import { migrateSessionEntries, parseSessionEntries, type SessionEntry } from "../../src/core/session-manager.js";

const RESTORATION_DIRECTIVE = "[restore checkpointed session agent configuration after compaction]";
const CHECKPOINT_CUSTOM_TYPE = "compaction.agent-checkpoint";

interface FutureModelRef {
	provider: string;
	modelId: string;
}

interface FutureAgentCheckpoint extends AgentCheckpoint {
	agentName?: string;
	model?: FutureModelRef;
	activeTools?: string[];
}

interface AppendCall<T = unknown> {
	customType: string;
	data: T;
}

interface FakePi {
	appendCalls: AppendCall[];
	persistedCheckpoints: FutureAgentCheckpoint[];
	currentSessionModel: FutureModelRef | undefined;
	appendEntry: <T = unknown>(customType: string, data?: T) => void;
}

function createFakePi(currentSessionModel?: FutureModelRef): FakePi {
	const appendCalls: AppendCall[] = [];
	const persistedCheckpoints: FutureAgentCheckpoint[] = [];
	return {
		appendCalls,
		persistedCheckpoints,
		currentSessionModel,
		appendEntry<T>(customType: string, data?: T) {
			appendCalls.push({ customType, data: data as unknown });
			if (customType === CHECKPOINT_CUSTOM_TYPE && data) {
				persistedCheckpoints.push(data as unknown as FutureAgentCheckpoint);
			}
		},
	};
}

type CaptureFn = (input: {
	agentName?: string;
	model?: FutureModelRef;
	activeTools?: string[];
}) => FutureAgentCheckpoint;
type PersistFn = (checkpoint: FutureAgentCheckpoint, pi: Pick<FakePi, "appendEntry">) => void;
type GetLatestFn = (pi: FakePi) => FutureAgentCheckpoint | undefined;
type InjectDirectiveFn = (checkpoint?: FutureAgentCheckpoint, fallback?: { model?: FutureModelRef }) => string;

const captureAgentCheckpointFuture = captureAgentCheckpoint as unknown as CaptureFn;
const persistCheckpointFuture = persistCheckpoint as unknown as PersistFn;
const getLatestCheckpointFuture = getLatestCheckpoint as unknown as GetLatestFn;
const injectRestorationDirectiveFuture = injectRestorationDirective as unknown as InjectDirectiveFn;

const registrations: Array<{ unregister: () => void }> = [];

afterEach(() => {
	for (const registration of registrations.splice(0)) {
		registration.unregister();
	}
});

let checkpointFixtureEntries: SessionEntry[] = [];

beforeAll(() => {
	const fixturePath = join(__dirname, "..", "fixtures", "compaction", "agent-checkpoint", "multi-agent-state.jsonl");
	const content = readFileSync(fixturePath, "utf-8");
	const entries = parseSessionEntries(content);
	migrateSessionEntries(entries);
	checkpointFixtureEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
});

describe("compaction agent checkpoint", () => {
	describe("Given a session with an active reviewer agent (momus) using claude-sonnet-4-5 and read/edit tools", () => {
		describe("When session_before_compact fires and the checkpoint is captured + persisted", () => {
			it("Then pi.appendEntry receives 'compaction.agent-checkpoint' with agent name, model, and activeTools", () => {
				const registration = registerFauxProvider({
					models: [{ id: "faux-momus" }],
				});
				registrations.push(registration);
				expect(checkpointFixtureEntries.length).toBeGreaterThan(0);

				const pi = createFakePi();
				const checkpoint = captureAgentCheckpointFuture({
					agentName: "momus",
					model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
					activeTools: ["read", "edit"],
				});
				persistCheckpointFuture(checkpoint, pi);

				const persisted = pi.appendCalls.find((call) => call.customType === CHECKPOINT_CUSTOM_TYPE);
				expect(persisted).toBeDefined();
				const data = persisted?.data as FutureAgentCheckpoint | undefined;
				expect(data?.agentName).toBe("momus");
				expect(data?.model).toEqual({ provider: "anthropic", modelId: "claude-sonnet-4-5" });
				expect(data?.activeTools).toEqual(["read", "edit"]);
				expect(typeof data?.timestamp).toBe("number");
			});
		});
	});

	describe("Given a checkpoint has been persisted via pi.appendEntry", () => {
		describe("When the restoration directive is injected on before_agent_start", () => {
			it("Then it equals the verbatim '[restore checkpointed session agent configuration after compaction]'", () => {
				const checkpoint: FutureAgentCheckpoint = {
					timestamp: 1705334410000,
					agentName: "momus",
					model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
					activeTools: ["read", "edit"],
				};

				const directive = injectRestorationDirectiveFuture(checkpoint);

				expect(directive).toBe("[restore checkpointed session agent configuration after compaction]");
				expect(directive).toBe(RESTORATION_DIRECTIVE);
			});
		});
	});

	describe("Given the restoration directive has been emitted on before_agent_start", () => {
		describe("When the next agent turn starts and the latest checkpoint is read", () => {
			it("Then agent identity, model, and activeTools all match the pre-compaction snapshot", () => {
				const pi = createFakePi();
				const original: FutureAgentCheckpoint = {
					timestamp: 1705334410000,
					agentName: "momus",
					model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
					activeTools: ["read", "edit", "write"],
				};
				persistCheckpointFuture(original, pi);

				const restored = getLatestCheckpointFuture(pi);

				expect(restored).toBeDefined();
				expect(restored?.agentName).toBe(original.agentName);
				expect(restored?.model).toEqual(original.model);
				expect(restored?.activeTools).toEqual(original.activeTools);
			});
		});
	});

	describe("Given a checkpoint with a degraded payload where 'model' is unset", () => {
		describe("When restoration runs against the current session model fallback", () => {
			it("Then injectRestorationDirective gracefully falls back to the current session model", () => {
				const fallbackSessionModel: FutureModelRef = {
					provider: "anthropic",
					modelId: "claude-sonnet-4-5",
				};
				const degradedCheckpoint: FutureAgentCheckpoint = {
					timestamp: 1705334410000,
					agentName: "momus",
					model: undefined,
					activeTools: ["read"],
				};

				const directive = injectRestorationDirectiveFuture(degradedCheckpoint, {
					model: fallbackSessionModel,
				});

				expect(directive).toContain(RESTORATION_DIRECTIVE);
				expect(directive).toContain(fallbackSessionModel.modelId);
			});
		});
	});

	describe("Given multiple compactions in a single session each persisting a checkpoint", () => {
		describe("When getLatestCheckpoint runs after the third compaction", () => {
			it("Then the most recent (highest-timestamp) checkpoint is returned, not a stale earlier one", () => {
				const pi = createFakePi();
				const earliest: FutureAgentCheckpoint = {
					timestamp: 1000,
					agentName: "alpha",
					model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
					activeTools: ["read"],
				};
				const middle: FutureAgentCheckpoint = {
					timestamp: 2000,
					agentName: "beta",
					model: { provider: "openai", modelId: "gpt-5.1-codex" },
					activeTools: ["read", "write"],
				};
				const latest: FutureAgentCheckpoint = {
					timestamp: 3000,
					agentName: "gamma",
					model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
					activeTools: ["read", "write", "edit"],
				};

				persistCheckpointFuture(earliest, pi);
				persistCheckpointFuture(middle, pi);
				persistCheckpointFuture(latest, pi);

				const restored = getLatestCheckpointFuture(pi);

				expect(restored).toBeDefined();
				expect(restored?.timestamp).toBe(3000);
				expect(restored?.agentName).toBe("gamma");
				expect(restored?.activeTools).toEqual(["read", "write", "edit"]);
			});
		});
	});
});
