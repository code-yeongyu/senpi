import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { estimateTokens } from "../../src/core/compaction/compaction.ts";
import {
	addAccount,
	type CursorCliAccountSlot,
	type CursorCliOauthCredential,
	emptyCredential,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/accounts.ts";
import { rendezvousOrder } from "../../src/core/extensions/builtin/cursor-cli-oauth/affinity.ts";
import type { CursorCliOauthProviderSettings } from "../../src/core/extensions/builtin/cursor-cli-oauth/settings.ts";
import {
	CURSOR_CLI_OAUTH_PROVIDER_ID,
	type CursorCliStreamDeps,
	streamCursorCliOauth,
} from "../../src/core/extensions/builtin/cursor-cli-oauth/stream.ts";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(TEST_DIRECTORY, "../fixtures/fake-cursor-agent.mjs");
const NOW = 1_787_000_000_000;
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "cursor-cli-stream-"));
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
		accounts.reduce((credential, slot) => addAccount(credential, slot), emptyCredential()),
	);
	return store;
}

function enabledSettings(overrides: Partial<CursorCliOauthProviderSettings> = {}): CursorCliOauthProviderSettings {
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
		denyCommands: [],
		...overrides,
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
	contextWindow: 200_000,
	maxTokens: 64_000,
};

function context(prompt: string): Context {
	return { messages: [{ role: "user", content: prompt, timestamp: NOW }] };
}

function fixtureExecutable(directory: string, scenario: string): { executable: string; dump: string } {
	const copiedFixture = join(directory, "fake-cursor-agent.mjs");
	const executable = join(directory, "cursor-agent");
	const dump = join(directory, "invocation.json");
	copyFileSync(FIXTURE, copiedFixture);
	writeFileSync(
		executable,
		`#!/bin/sh\nFAKE_CURSOR_ARGV_DUMP=${JSON.stringify(dump)} FAKE_CURSOR_SCENARIO=${scenario} FAKE_CURSOR_GRANDCHILD_PID_FILE=${JSON.stringify(join(directory, "grandchild.pid"))} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(copiedFixture)} "$@"\n`,
		{ mode: 0o700 },
	);
	chmodSync(executable, 0o700);
	return { executable, dump };
}

/**
 * A fixture that rate-limits the account whose sandbox HOME it runs under and
 * streams a happy turn for every other account. Both accounts share this
 * executable, so account selection alone decides the outcome.
 */
function accountAwareFixture(directory: string, rateLimitedAccount: string): { executable: string; dump: string } {
	const script = join(directory, "account-aware.mjs");
	const executable = join(directory, "cursor-agent");
	const dump = join(directory, "invocation.json");
	writeFileSync(
		script,
		[
			`const RATE_LIMITED = ${JSON.stringify(rateLimitedAccount)};`,
			`const DUMP = ${JSON.stringify(dump)};`,
			`import { writeFileSync } from "node:fs";`,
			`const env = {};`,
			`for (const name of ["HOME", "PATH", "AGENT_CLI_CREDENTIAL_STORE", "TERM", "LANG", "LC_ALL", "FORCE_COLOR"]) {`,
			`  if (process.env[name] !== undefined) env[name] = process.env[name];`,
			`}`,
			`writeFileSync(DUMP, JSON.stringify({ argv: process.argv.slice(2), env }, null, 2) + "\\n");`,
			`const account = /accounts\\/([^/]+)\\/home$/.exec(process.env.HOME ?? "")?.[1] ?? "unknown";`,
			`const SESSION_ID = "fake-session-001";`,
			`function writeEvent(event) { process.stdout.write(JSON.stringify(event) + "\\n"); }`,
			`if (account === RATE_LIMITED) {`,
			`  process.stderr.write("Error: rate limit exceeded. Please try again later.\\n");`,
			`  process.exitCode = 1;`,
			`} else {`,
			`  writeEvent({ type: "system", subtype: "init", apiKeySource: "login", cwd: "/tmp", session_id: SESSION_ID, model: "Composer 2.5 Fast", permissionMode: "default" });`,
			`  writeEvent({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "FAILOVER OK" }] } });`,
			`  writeEvent({ type: "result", subtype: "success", duration_ms: 50, is_error: false, result: "FAILOVER OK", session_id: SESSION_ID, request_id: "req-failover", usage: { inputTokens: 500, outputTokens: 9, cacheReadTokens: 40, cacheWriteTokens: 0 } });`,
			`}`,
		].join("\n"),
		{ mode: 0o600 },
	);
	writeFileSync(
		executable,
		`#!/bin/sh\nFAKE_CURSOR_ARGV_DUMP=${JSON.stringify(dump)} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
		{ mode: 0o700 },
	);
	chmodSync(executable, 0o700);
	return { executable, dump };
}

/**
 * A complete tool turn: init, tool started+completed with stdout, an assistant
 * fragment, and a successful result. The shared fixture's `tools` scenario
 * stops after the tool frames, which is not a turn the router can complete.
 */
function toolsTurnFixture(directory: string): string {
	const script = join(directory, "tools-turn.mjs");
	const executable = join(directory, "cursor-agent");
	writeFileSync(
		script,
		[
			`const DUMP = ${JSON.stringify(join(directory, "invocation.json"))};`,
			`import { writeFileSync } from "node:fs";`,
			`const env = {};`,
			`for (const name of ["HOME", "PATH", "AGENT_CLI_CREDENTIAL_STORE", "TERM", "LANG", "LC_ALL", "FORCE_COLOR"]) {`,
			`  if (process.env[name] !== undefined) env[name] = process.env[name];`,
			`}`,
			`writeFileSync(DUMP, JSON.stringify({ argv: process.argv.slice(2), env }, null, 2) + "\\n");`,
			`const SESSION_ID = "fake-session-001";`,
			`const CALL_ID = "tool_fake-shell-001";`,
			`function writeEvent(event) { process.stdout.write(JSON.stringify(event) + "\\n"); }`,
			`writeEvent({ type: "system", subtype: "init", apiKeySource: "login", cwd: "/tmp", session_id: SESSION_ID, model: "Composer 2.5 Fast", permissionMode: "default" });`,
			`writeEvent({ type: "tool_call", subtype: "started", call_id: CALL_ID, tool_call: { shellToolCall: { args: { command: "echo tooltest-force-77" } } } });`,
			`writeEvent({ type: "tool_call", subtype: "completed", call_id: CALL_ID, tool_call: { shellToolCall: { args: { command: "echo tooltest-force-77" }, result: { success: { exitCode: 0, stdout: "tooltest-force-77\\n", stderr: "", executionTime: 25 } } } } });`,
			`writeEvent({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "TOOLS OK" }] } });`,
			`writeEvent({ type: "result", subtype: "success", duration_ms: 80, is_error: false, result: "TOOLS OK", session_id: SESSION_ID, request_id: "req-tools", usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 0 } });`,
		].join("\n"),
		{ mode: 0o600 },
	);
	writeFileSync(
		executable,
		`#!/bin/sh\nFAKE_CURSOR_ARGV_DUMP=${JSON.stringify(join(directory, "invocation.json"))} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
		{ mode: 0o700 },
	);
	chmodSync(executable, 0o700);
	return executable;
}

function silentExecutable(directory: string): string {
	const executable = join(directory, "cursor-agent");
	writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
	chmodSync(executable, 0o700);
	return executable;
}

function runTurn(deps: CursorCliStreamDeps, prompt: string, sessionId: string): AssistantMessageEventStream {
	return streamCursorCliOauth(model, context(prompt), { sessionId }, deps);
}

async function collect(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

function textDeltas(events: readonly AssistantMessageEvent[]): string[] {
	return events
		.filter((event): event is Extract<AssistantMessageEvent, { type: "text_delta" }> => event.type === "text_delta")
		.map((event) => event.delta);
}

function textBlocks(message: AssistantMessage): string[] {
	return message.content
		.filter((block): block is Extract<AssistantMessage["content"][number], { type: "text" }> => block.type === "text")
		.map((block) => block.text);
}

function doneMessage(events: readonly AssistantMessageEvent[]): AssistantMessage {
	const done = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "done" }> => event.type === "done",
	);
	if (!done) throw new Error("stream finished without a done event");
	return done.message;
}

function errorEvent(events: readonly AssistantMessageEvent[]): Extract<AssistantMessageEvent, { type: "error" }> {
	const failure = events.find(
		(event): event is Extract<AssistantMessageEvent, { type: "error" }> => event.type === "error",
	);
	if (!failure) throw new Error("stream finished without an error event");
	return failure;
}

function invocation(dump: string): { argv: string[]; env: Record<string, string> } {
	return JSON.parse(readFileSync(dump, "utf8")) as { argv: string[]; env: Record<string, string> };
}

afterEach(() => {
	delete process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("cursor-cli-oauth stream mapping", () => {
	it("maps assistant fragments to ordered text deltas, thinking to reasoning, and the result to stop plus usage", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings(),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		const events = await collect(runTurn(deps, "hello stream test", "stream-happy"));

		expect(events[0]?.type).toBe("start");
		expect(textDeltas(events)).toEqual(["STREAM", "TEST OK"]);
		const thinkingDeltas = events
			.filter(
				(event): event is Extract<AssistantMessageEvent, { type: "thinking_delta" }> =>
					event.type === "thinking_delta",
			)
			.map((event) => event.delta);
		expect(thinkingDeltas).toEqual(["Preparing deterministic response."]);

		const message = doneMessage(events);
		expect(message.stopReason).toBe("stop");
		expect(textBlocks(message)).toEqual(["STREAMTEST OK"]);
		const thinking = message.content.find(
			(block): block is Extract<AssistantMessage["content"][number], { type: "thinking" }> =>
				block.type === "thinking",
		);
		expect(thinking?.thinking).toBe("Preparing deterministic response.");
		expect(message.content.some((block) => block.type === "toolCall")).toBe(false);

		const sentPrompt = invocation(fixture.dump).argv[1];
		expect(sentPrompt).toBe("hello stream test");
		expect(sentPrompt.includes("--resume")).toBe(false);
	});

	it("isolates CLI usage numbers from AssistantMessage.usage and carries them only in a diagnostic", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings(),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		const events = await collect(runTurn(deps, "hello stream test", "stream-usage"));
		const message = doneMessage(events);

		const sentPrompt = invocation(fixture.dump).argv[1] ?? "";
		const expectedInput = estimateTokens({
			role: "user",
			content: sentPrompt,
			timestamp: NOW,
		} satisfies AgentMessage);
		// The CLI fixture reports inputTokens: 12, cacheReadTokens: 3.
		expect(expectedInput).not.toBe(12);
		expect(message.usage.input).toBe(expectedInput);
		expect(message.usage.output).toBe(7);
		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.cacheWrite).toBe(0);
		expect(message.usage.totalTokens).toBe(0);

		const diagnostic = message.diagnostics?.find((entry) => entry.type === "cursor_cli_oauth_cli_usage");
		expect(diagnostic).toBeDefined();
		expect(diagnostic?.details).toMatchObject({
			inputTokens: 12,
			cacheReadTokens: 3,
			cacheWriteTokens: 0,
			outputTokens: 7,
			requestId: "fake-request-001",
		});
	});

	it("renders tool frames as display-only blocks labelled as executed by the Cursor CLI", async () => {
		const directory = temporaryDirectory();
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings(),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = toolsTurnFixture(directory);

		const events = await collect(runTurn(deps, "run the tool", "stream-tools"));
		const message = doneMessage(events);

		expect(message.content.some((block) => block.type === "toolCall")).toBe(false);
		const rendered = textBlocks(message).join("\n");
		expect(rendered).toContain("executed by the Cursor CLI");
		// Untrusted tool output stays inside the delimited display region.
		const withoutDisplayRegions = rendered.replace(/<cursor-cli-tool>[\s\S]*?<\/cursor-cli-tool>/g, "");
		expect(withoutDisplayRegions).not.toContain("tooltest-force-77");
		expect(rendered).toContain("tooltest-force-77");
	});

	it("surfaces a zero-exit turn with no assistant events as an error, never an empty success", async () => {
		const directory = temporaryDirectory();
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings(),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = silentExecutable(directory);

		const events = await collect(runTurn(deps, "say anything", "stream-silent"));
		const failure = errorEvent(events);

		expect(failure.reason).toBe("error");
		expect(failure.error.errorMessage ?? "").toMatch(/result event|visible assistant text/);
		expect(textBlocks(failure.error).join("")).toBe("");
	});

	it("fails over to the next account before any visible output and emits the context-loss notice", async () => {
		const directory = temporaryDirectory();
		const accounts = [account("alpha"), account("bravo")];
		const first = rendezvousOrder("stream-failover", accounts)[0];
		const fixture = accountAwareFixture(directory, first.name);
		const storeUnderTest = await makeStore(accounts);
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: storeUnderTest,
			settings: enabledSettings(),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		const events = await collect(runTurn(deps, "failover please", "stream-failover"));
		const message = doneMessage(events);

		const second = accounts.find((slot) => slot.name !== first.name);
		const deltas = textDeltas(events);
		expect(deltas.join("")).toContain(
			`Cursor account changed from '${first.name}' to '${second?.name}'; a fresh chat was started and prior context was not carried over.`,
		);
		expect(textBlocks(message).join("")).toContain("FAILOVER OK");
		const storedCredential = await storeUnderTest.read(CURSOR_CLI_OAUTH_PROVIDER_ID);
		expect(
			(storedCredential as { accounts?: CursorCliAccountSlot[] }).accounts?.find((slot) => slot.name === first.name),
		).toMatchObject({
			blockReason: "rate_limit",
		});
	});

	it("re-selects settings and accounts freshly across back-to-back turns", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const store = await makeStore([account("alpha")]);
		const agentDir = join(directory, "agent");
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir,
			store,
			settings: enabledSettings(),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		const firstTurn = await collect(runTurn(deps, "first turn", "stream-stale"));
		expect(firstTurn.at(-1)?.type).toBe("done");
		expect(invocation(fixture.dump).argv).not.toContain("--resume");

		// Block the only account and add a replacement between turns.
		const later = NOW + 60_000;
		await store.modify(CURSOR_CLI_OAUTH_PROVIDER_ID, async (current) => {
			const credential = (current?.type === "oauth" ? current : emptyCredential()) as CursorCliOauthCredential;
			const withBravo = addAccount(credential, account("bravo"));
			return {
				...withBravo,
				accounts: (withBravo.accounts ?? []).map((slot) =>
					slot.name === "alpha" ? { ...slot, blockedUntil: later, blockReason: "rate_limit" as const } : slot,
				),
			};
		});

		const secondTurn = await collect(runTurn(deps, "second turn", "stream-stale"));
		expect(secondTurn.at(-1)?.type).toBe("done");

		const second = invocation(fixture.dump);
		expect(second.env.HOME).toContain(join("accounts", "bravo", "home"));
		// The new account owns no chat, so the turn must not resume the old one.
		expect(second.argv).not.toContain("--resume");
		expect(existsSync(join(agentDir, "cursor-cli-oauth", "accounts", "bravo", "home", ".cursor", "auth.json"))).toBe(
			true,
		);
	});

	it("resumes the sticky chat on the second same-model turn", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings(),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		await collect(runTurn(deps, "first turn", "stream-resume"));
		await collect(runTurn(deps, "second turn", "stream-resume"));

		const argv = invocation(fixture.dump).argv;
		const resumeIndex = argv.indexOf("--resume");
		expect(resumeIndex).toBeGreaterThan(-1);
		expect(argv[resumeIndex + 1]).toBe("fake-session-001");
	});

	it("refuses to spawn when the lane is disabled by settings", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings({ enabled: false, explicitlyDisabled: true }),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		const events = await collect(runTurn(deps, "hello", "stream-disabled"));
		const failure = errorEvent(events);

		expect(failure.error.errorMessage ?? "").toContain("disabled by settings");
		expect(existsSync(fixture.dump)).toBe(false);
	});

	it("reports the missing-account state instead of spawning", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([]),
			settings: enabledSettings(),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		const events = await collect(runTurn(deps, "hello", "stream-noaccounts"));
		const failure = errorEvent(events);

		expect(failure.error.errorMessage ?? "").toContain("no accounts: run /login cursor-cli-oauth");
		expect(existsSync(fixture.dump)).toBe(false);
	});

	it("surfaces the typed install guidance on the turn path when the executable is missing", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings(),
			now: () => NOW,
			// Resolution fails exactly as a machine without cursor-agent installed
			// would: no overrides, nothing on PATH, no versions directory.
			executableDeps: {
				env: () => undefined,
				settings: {},
				homeDirectory: directory,
				pathDelimiter: ":",
				isExecutableFile: () => false,
				readDirectory: () => {
					throw new Error("no versions directory");
				},
			},
		};

		const events = await collect(runTurn(deps, "hello", "stream-missing-executable"));
		const failure = errorEvent(events);

		expect(failure.reason).toBe("error");
		expect(failure.error.errorMessage ?? "").toContain("cursor-agent not installed");
		expect(failure.error.errorMessage ?? "").toContain("curl https://cursor.com/install -fsS | bash");
		// The turn must fail before any spawn or credential-home work.
		expect(existsSync(fixture.dump)).toBe(false);
		expect(existsSync(join(directory, "agent", "cursor-cli-oauth"))).toBe(false);
	});

	it("refuses an unacknowledged force turn before any spawn", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const agentDir = join(directory, "agent");
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir,
			store: await makeStore([account("alpha")]),
			settings: enabledSettings({ noApprovalAcknowledgedAt: undefined }),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		const events = await collect(runTurn(deps, "hello", "stream-refusal"));
		const failure = errorEvent(events);

		expect(failure.reason).toBe("error");
		expect(failure.error.errorMessage ?? "").toContain("noApprovalAcknowledgedAt");
		expect(failure.error.errorMessage ?? "").toContain("acknowledge");
		// Zero spawns: the fake executable only writes its dump when it actually runs.
		expect(existsSync(fixture.dump)).toBe(false);
		// The refusal happens before any account work: no credential home is created either.
		expect(existsSync(join(agentDir, "cursor-cli-oauth"))).toBe(false);
	});

	it("applies the deny config inside the spawned HOME and re-applies it after a CLI rewrite", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const agentDir = join(directory, "agent");
		const denyConfigPath = join(
			agentDir,
			"cursor-cli-oauth",
			"accounts",
			"alpha",
			"home",
			".cursor",
			"cli-config.json",
		);
		const deps: CursorCliStreamDeps = {
			cwd: directory,
			agentDir,
			store: await makeStore([account("alpha")]),
			settings: enabledSettings({ denyCommands: ["rm -rf /"] }),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		await collect(runTurn(deps, "first turn", "stream-deny"));
		expect(JSON.parse(readFileSync(denyConfigPath, "utf8"))).toEqual({
			permissions: { deny: ["Shell(rm -rf /)"] },
		});

		// Mid-session the CLI rewrites its own config and drops the deny entries.
		writeFileSync(denyConfigPath, JSON.stringify({ autoUpdates: true, permissions: { allow: ["Shell(ls)"] } }));

		await collect(runTurn(deps, "second turn", "stream-deny"));
		// The deny list is restored before the second spawn and CLI-owned keys survive.
		expect(JSON.parse(readFileSync(denyConfigPath, "utf8"))).toEqual({
			autoUpdates: true,
			permissions: { allow: ["Shell(ls)"], deny: ["Shell(rm -rf /)"] },
		});
	});

	it("includes --force only once acknowledged and honours plan mode without it", async () => {
		const directory = temporaryDirectory();
		const fixture = fixtureExecutable(directory, "happy");
		const acknowledged: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings(),
			now: () => NOW,
		};
		process.env.SENPI_CURSOR_CLI_OAUTH_EXECUTABLE = fixture.executable;

		await collect(runTurn(acknowledged, "forced turn", "stream-force"));
		expect(invocation(fixture.dump).argv).toContain("--force");

		const planMode: CursorCliStreamDeps = {
			cwd: directory,
			agentDir: join(directory, "agent-plan"),
			store: await makeStore([account("alpha")]),
			settings: enabledSettings({ executionMode: "plan", noApprovalAcknowledgedAt: undefined }),
			now: () => NOW,
		};
		const events = await collect(runTurn(planMode, "planning turn", "stream-plan"));
		expect(events.at(-1)?.type).toBe("done");
		const argv = invocation(fixture.dump).argv;
		const modeIndex = argv.indexOf("--mode");
		expect(modeIndex).toBeGreaterThan(-1);
		expect(argv[modeIndex + 1]).toBe("plan");
		expect(argv).not.toContain("--force");
	});
});
