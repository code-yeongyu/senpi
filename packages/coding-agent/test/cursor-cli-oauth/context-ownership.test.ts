import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type Context,
	InMemoryCredentialStore,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	shouldCompact,
} from "../../src/core/compaction/compaction.ts";
import { registerSessionRegistry } from "../../src/core/extensions/builtin/claude-sdk-oauth/session-registry-wiring.ts";
import {
	addAccount,
	type CursorCliAccountSlot,
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import { classifyCursorCliError } from "../../src/core/extensions/builtin/cursor-cli-oauth/errors.ts";
import { CursorAgentNotInstalledError } from "../../src/core/extensions/builtin/cursor-cli-oauth/executable.ts";
import {
	CURSOR_CLI_OAUTH_PROVIDER_ID,
	type CursorCliOauthExtensionDeps,
	registerCursorCliOauthExtension,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/index.ts";
import {
	CURSOR_CLI_CONTEXT_RECAP_BEGIN,
	CURSOR_CLI_CONTEXT_RECAP_END,
	type CursorCliRecapExchange,
	type CursorCliSessionRestartNotice,
	CursorCliSessionRouter,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/session-router.ts";
import type { CursorCliOauthProviderSettings } from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import {
	type CursorCliStreamDeps,
	streamCursorCliOauth,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/stream.ts";
import { builtinExtensions } from "../../src/core/extensions/builtin/index.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import type { ProviderConfigInput } from "../../src/core/provider-composer.ts";

/**
 * Todo 20 proof: senpi keeps context ownership for the cursor-cli-oauth lane.
 *
 * The four historical defect classes this fences (F1-F4) all start the same
 * way: a subprocess-reported context number becomes senpi's own context base.
 * These tests run the REAL core estimator (`estimateContextTokens`) and the
 * REAL lane mapping (`streamCursorCliOauth`) against a hermetic fake CLI that
 * reports an enormous `inputTokens`, and pin that:
 *  (a) the session estimate stays derived from senpi's own payload,
 *  (b) writing the CLI number into `usage.input` WOULD inflate the estimate
 *      (the failure mode exists, so (a) is not vacuous),
 *  (c) the extension registers no `session_compact` handler (F4 cannot arise),
 *  (d) a CLI `context_overflow` restarts the chat with a senpi recap instead
 *      of surfacing as a compaction failure.
 */

const NOW = 1_787_000_000_000;
const PROMPT = "prove senpi keeps context ownership after this turn";
const ANSWER = "OWNERSHIP INTACT";

/** Numbers the fake CLI reports; enormous on purpose so any leak is unmistakable. */
const CLI_INPUT_TOKENS = 900_000;
const CLI_OUTPUT_TOKENS = 9;
const CLI_CACHE_READ_TOKENS = 120_000;
const CLI_CACHE_WRITE_TOKENS = 4_000;
const CONTEXT_WINDOW = 200_000;

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "cursor-cli-ownership-"));
	temporaryDirectories.push(directory);
	return directory;
}

function account(name: string): CursorCliAccountSlot {
	return {
		name,
		access: `access-${name}`,
		refresh: `refresh-${name}`,
		expires: NOW + 3_600_000,
		source: "login",
	};
}

async function makeStore(accounts: readonly CursorCliAccountSlot[]): Promise<InMemoryCredentialStore> {
	const store = new InMemoryCredentialStore();
	await store.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async () =>
		accounts.reduce(
			(credential, slot) => addAccount(credential, slot),
			emptyCredential() as CursorCliOauthCredential,
		),
	);
	return store;
}

function enabledSettings(): CursorCliOauthProviderSettings {
	return {
		enabled: true,
		explicitlyDisabled: false,
		executablePath: undefined,
		forceExecution: true,
		noApprovalAcknowledgedAt: "2026-08-17T00:00:00.000Z",
		executionMode: "agent",
		resumeMode: "auto",
		pinnedAccount: undefined,
		contextRecapOnModelSwitch: true,
		modelCatalogTtlHours: 24,
		sandboxMode: undefined,
	};
}

const model: Model<Api> = {
	id: "fake-cursor-model",
	name: "Fake Cursor Model",
	api: CURSOR_CLI_OAUTH_PROVIDER_ID,
	provider: CURSOR_CLI_OAUTH_PROVIDER_ID,
	baseUrl: CURSOR_CLI_OAUTH_PROVIDER_ID,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: CONTEXT_WINDOW,
	maxTokens: 64_000,
};

function contextFor(prompt: string): Context {
	return { messages: [{ role: "user", content: prompt, timestamp: NOW }] };
}

/**
 * A fake cursor-agent that reports a huge `inputTokens`/`cacheReadTokens` on
 * its result event - the adversarial CLI from the plan's F3 mirror defect.
 */
function hugeUsageFixture(directory: string): { executable: string; dump: string } {
	const script = join(directory, "huge-usage.mjs");
	const executable = join(directory, "cursor-agent");
	const dump = join(directory, "invocation.json");
	writeFileSync(
		script,
		[
			`import { writeFileSync } from "node:fs";`,
			`writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2) }, null, 2) + "\\n");`,
			`const SESSION_ID = "fake-session-huge";`,
			`function writeEvent(event) { process.stdout.write(JSON.stringify(event) + "\\n"); }`,
			`writeEvent({ type: "system", subtype: "init", apiKeySource: "login", cwd: "/tmp", session_id: SESSION_ID, model: "Composer 2.5 Fast", permissionMode: "default" });`,
			`writeEvent({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(ANSWER)} }] }, session_id: SESSION_ID });`,
			`writeEvent({ type: "result", subtype: "success", duration_ms: 42, is_error: false, result: ${JSON.stringify(ANSWER)}, session_id: SESSION_ID, request_id: "req-huge-usage", usage: { inputTokens: ${CLI_INPUT_TOKENS}, outputTokens: ${CLI_OUTPUT_TOKENS}, cacheReadTokens: ${CLI_CACHE_READ_TOKENS}, cacheWriteTokens: ${CLI_CACHE_WRITE_TOKENS} } });`,
		].join("\n"),
		{ mode: 0o600 },
	);
	writeFileSync(executable, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, {
		mode: 0o700,
	});
	chmodSync(executable, 0o700);
	return { executable, dump };
}

/** An executable that resolves but prints nothing, keeping the builtin-factory catalog probe offline. */
function silentExecutable(directory: string): string {
	const executable = join(directory, "cursor-agent");
	writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	chmodSync(executable, 0o700);
	return executable;
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function doneMessage(events: readonly AssistantMessageEvent[]): AssistantMessage {
	const done = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	if (!done) throw new Error("stream finished without a done event");
	return done.message;
}

function userMessage(prompt: string): AgentMessage {
	return { role: "user", content: prompt, timestamp: NOW };
}

type RouterTestEvent =
	| { type: "system"; subtype: "init"; session_id: string; model: string }
	| { type: "assistant"; message: { content: Array<{ type: "text"; text: string }> } };

type RouterOutputEvent = RouterTestEvent | CursorCliSessionRestartNotice;

type ScriptStep = RouterTestEvent[] | { readonly failure: unknown };

function initEvent(sessionId: string, modelId: string): RouterTestEvent {
	return { type: "system", subtype: "init", session_id: sessionId, model: modelId };
}

function assistantEvent(text: string): RouterTestEvent {
	return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

function scriptedRunner(script: readonly ScriptStep[]): {
	attempts: Array<{ prompt: string; resumeChatId: string | undefined }>;
	runAttempt: (attempt: { prompt: string; resumeChatId: string | undefined }) => AsyncIterable<RouterTestEvent>;
} {
	const attempts: Array<{ prompt: string; resumeChatId: string | undefined }> = [];
	const runAttempt = (attempt: {
		prompt: string;
		resumeChatId: string | undefined;
	}): AsyncIterable<RouterTestEvent> => {
		attempts.push(attempt);
		const step = script[attempts.length - 1];
		if (step === undefined) throw new Error(`unexpected attempt #${attempts.length}`);
		return (async function* () {
			if (!Array.isArray(step)) throw step.failure;
			for (const event of step) yield event;
		})();
	};
	return { attempts, runAttempt };
}

async function collectRouter(stream: AsyncIterable<RouterOutputEvent>): Promise<RouterOutputEvent[]> {
	const events: RouterOutputEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

/** Records every provider registration and event-handler subscription an extension makes. */
function recordingApi(): {
	pi: ExtensionAPI;
	providerIds: string[];
	registeredEvents: string[];
} {
	const providerIds: string[] = [];
	const registeredEvents: string[] = [];
	const pi = {
		registerProvider: (name: string, _config: ProviderConfigInput): void => {
			providerIds.push(name);
		},
		registerCommand: (): void => {},
		registerFlag: (): void => {},
		getFlag: (): undefined => undefined,
		on: (event: string, _handler: unknown): void => {
			registeredEvents.push(event);
		},
	} as unknown as ExtensionAPI;
	return { pi, providerIds, registeredEvents };
}

afterEach(() => {
	delete process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cursor-cli-oauth context ownership", () => {
	it("(a) keeps estimateContextTokens derived from senpi's own payload when the CLI reports an enormous inputTokens", async () => {
		const directory = temporaryDirectory();
		const fixture = hugeUsageFixture(directory);
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings(),
			now: () => NOW,
		};

		// The AssistantMessage is built by the real stream.ts mapper, exactly as a
		// live lane turn builds it; only the CLI binary itself is hermetically fake.
		const events = await collect(
			streamCursorCliOauth(model, contextFor(PROMPT), { sessionId: "ownership-lane" }, deps),
		);
		const message = doneMessage(events);

		// stream.ts's usage construction: input is senpi's estimate of the payload it
		// actually sent (read back from the spawned argv), output is the CLI's number,
		// cache/total are zeroed, and the CLI's context numbers live only in a diagnostic.
		const sentPrompt = (JSON.parse(readFileSync(fixture.dump, "utf8")) as { argv: string[] }).argv[1] ?? "";
		const senpiPayloadTokens = estimateTokens({
			role: "user",
			content: sentPrompt,
			timestamp: NOW,
		} satisfies AgentMessage);
		expect(sentPrompt).toBe(PROMPT);
		expect(message.usage.input).toBe(senpiPayloadTokens);
		expect(message.usage.input).not.toBe(CLI_INPUT_TOKENS);
		expect(message.usage.output).toBe(CLI_OUTPUT_TOKENS);
		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.cacheWrite).toBe(0);
		expect(message.usage.totalTokens).toBe(0);
		const diagnostic = message.diagnostics?.find((entry) => entry.type === "cursor_cli_oauth_cli_usage");
		expect(diagnostic?.details).toMatchObject({
			inputTokens: CLI_INPUT_TOKENS,
			cacheReadTokens: CLI_CACHE_READ_TOKENS,
			outputTokens: CLI_OUTPUT_TOKENS,
		});

		// The real core estimator over the resulting session messages: the last
		// assistant usage is the authoritative base, so it must reflect senpi's own
		// payload, never the CLI-reported context size.
		const estimate = estimateContextTokens([userMessage(PROMPT), message]);
		expect(estimate.usageTokens).toBe(senpiPayloadTokens + CLI_OUTPUT_TOKENS);
		expect(estimate.tokens).toBe(senpiPayloadTokens + CLI_OUTPUT_TOKENS);
		expect(estimate.tokens).toBeLessThan(1_000);
		expect(shouldCompact(estimate.tokens, CONTEXT_WINDOW, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
	});

	it("(b) would inflate the estimate if the CLI numbers were written into usage.input (the failure mode exists)", () => {
		const senpiPayloadTokens = estimateTokens(userMessage(PROMPT));

		// Locally constructed - never through the lane: the F3 mirror defect is a
		// message whose usage carries the CLI-reported context numbers.
		const poisoned: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: ANSWER }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: CLI_INPUT_TOKENS,
				output: CLI_OUTPUT_TOKENS,
				cacheRead: CLI_CACHE_READ_TOKENS,
				cacheWrite: CLI_CACHE_WRITE_TOKENS,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: NOW,
		};

		// The failure mode: estimateContextTokens takes the last assistant usage at
		// face value, so the CLI's numbers become senpi's context base and the F2
		// admission wedge (shouldCompact flips true at a small real context) fires.
		const inflated = estimateContextTokens([userMessage(PROMPT), poisoned]);
		expect(inflated.tokens).toBe(
			CLI_INPUT_TOKENS + CLI_OUTPUT_TOKENS + CLI_CACHE_READ_TOKENS + CLI_CACHE_WRITE_TOKENS,
		);
		expect(inflated.tokens).toBeGreaterThanOrEqual(CLI_INPUT_TOKENS);
		expect(shouldCompact(inflated.tokens, CONTEXT_WINDOW, DEFAULT_COMPACTION_SETTINGS)).toBe(true);

		// Stale-state guard: the estimator returns per-call values (no memoization),
		// so the healthy session still estimates small after the poisoned one.
		const healthy: AssistantMessage = {
			...poisoned,
			usage: { ...poisoned.usage, input: senpiPayloadTokens, cacheRead: 0, cacheWrite: 0 },
		};
		expect(estimateContextTokens([userMessage(PROMPT), healthy]).tokens).toBeLessThan(1_000);
		expect(estimateContextTokens([userMessage(PROMPT), poisoned]).tokens).toBeGreaterThanOrEqual(CLI_INPUT_TOKENS);
		expect(estimateContextTokens([userMessage(PROMPT), healthy]).tokens).toBeLessThan(1_000);
	});

	it("(c) registers no session_compact handler on its registration surface", () => {
		const directory = temporaryDirectory();
		const first = recordingApi();
		const deps: CursorCliOauthExtensionDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: new InMemoryCredentialStore(),
			loadSettings: () => enabledSettings(),
			resolveExecutable: () => {
				throw new CursorAgentNotInstalledError();
			},
		};
		registerCursorCliOauthExtension(first.pi, deps);
		// The provider DID register on this surface, so the empty handler list is
		// not vacuous - the lane simply never subscribes to session_compact.
		expect(first.providerIds).toContain(CURSOR_CLI_OAUTH_PROVIDER_ID);
		expect(first.registeredEvents).not.toContain("session_compact");

		// The recording surface itself can observe such a handler: the Claude lane's
		// session registry (the F4 regression class) does register one.
		const claudeLane = recordingApi();
		registerSessionRegistry(claudeLane.pi);
		expect(claudeLane.registeredEvents).toContain("session_compact");

		// The shipped builtin wiring behaves the same as the deps-injected path.
		const entry = builtinExtensions.find((extension) => extension.id === "cursor-cli-oauth");
		expect(entry).toBeDefined();
		const second = recordingApi();
		// Keep the factory's catalog probe offline: a silent executable resolves but
		// yields no model listing, so no real binary is ever spawned from the test.
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = silentExecutable(directory);
		entry?.factory(second.pi);
		expect(second.providerIds).toContain(CURSOR_CLI_OAUTH_PROVIDER_ID);
		expect(second.registeredEvents).not.toContain("session_compact");
	});

	it("(d) routes a CLI context_overflow classification to a fresh chat with a senpi recap, not a compaction failure", async () => {
		const router = new CursorCliSessionRouter({ now: () => NOW });
		const routerContext = { senpiSessionId: "ownership-overflow", accountName: "alpha" };
		const seeded = scriptedRunner([[initEvent("chat-owned-1", "model-a"), assistantEvent("seeded")]]);
		await collectRouter(
			router.runTurn({ ...routerContext, runAttempt: seeded.runAttempt }, { prompt: "seed", model: "model-a" }),
		);

		const overflowStderr = "Error: prompt exceeds the maximum context length for this model's context window.";
		const exchanges: CursorCliRecapExchange[] = [
			{ role: "user", text: "earlier senpi exchange" },
			{ role: "assistant", text: "earlier senpi answer" },
		];
		const { attempts, runAttempt } = scriptedRunner([
			{ failure: { stderr: overflowStderr } },
			[initEvent("chat-owned-2", "model-a"), assistantEvent("fresh chat answer")],
		]);

		// The turn completes (no throw - a senpi compaction failure would abort it);
		// the classified overflow restarts the chat instead.
		const events = await collectRouter(
			router.runTurn(
				{
					...routerContext,
					runAttempt,
					classify: (input) =>
						input.stderr === overflowStderr
							? { kind: "context_overflow", retryable: false }
							: classifyCursorCliError(input),
				},
				{ prompt: "overflow turn", model: "model-a", recentExchanges: exchanges },
			),
		);

		// First attempt resumed the sticky chat; the retry spawned a FRESH chat.
		expect(attempts[0]?.resumeChatId).toBe("chat-owned-1");
		expect(attempts[1]?.resumeChatId).toBeUndefined();
		// senpi's own records - not CLI state - carry the context forward as the recap.
		expect(attempts[1]?.prompt.startsWith(CURSOR_CLI_CONTEXT_RECAP_BEGIN)).toBe(true);
		expect(attempts[1]?.prompt).toContain(CURSOR_CLI_CONTEXT_RECAP_END);
		expect(attempts[1]?.prompt).toContain("user: earlier senpi exchange");
		expect(attempts[1]?.prompt).toContain("assistant: earlier senpi answer");
		expect(attempts[1]?.prompt.endsWith("overflow turn")).toBe(true);

		const notices = events.filter(
			(event): event is CursorCliSessionRestartNotice => event.type === "cursor_chat_restarted",
		);
		expect(notices).toHaveLength(1);
		expect(notices[0]).toMatchObject({ previousChatId: "chat-owned-1", reason: "context_overflow" });
		expect(notices[0]?.message).toContain("re-injected");
		// The fresh chat's answer flowed through and routing now tracks the new chat.
		expect(events.at(-1)).toMatchObject({ type: "assistant" });
		expect(router.getRecord(routerContext.senpiSessionId)).toMatchObject({ chatId: "chat-owned-2" });
	});
});
