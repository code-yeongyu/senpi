/**
 * senpi#4436 (S5b): `test_provider_account` re-runs the sign-in connection test for one Claude CLI account
 * (the Retry of a failed check). It runs one turn pinned to the named account with account fallback off, on
 * the default model the settings resolve for Claude, stores only `check` and answers `{ check }`. A failed
 * turn changes no block, pin or other account. Other providers and unknown accounts get typed errors.
 *
 * Harness: the in-process classic RPC harness (as `test/rpc-get-media.test.ts`), with the auth lane's store
 * set to the session's own auth storage and the SDK boundary scripted, so no `claude` process is ever spawned
 * (the executable is a non-executable stub file).
 */

import { setMaxListeners } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AccountSlot,
	AnthropicSubscriptionCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { overrideAuthLaneBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { accountDirFor } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-account-dir.ts";
import { connectionTestModel } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-connection-test.ts";
import type { Options, SdkQuery } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { overrideSdkBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { PROVIDER_ACCOUNT_TEST_CAPABILITY } from "../../../src/modes/rpc/custom-capability.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { createFakeRuntimeHost, type ParsedOutputLine, parseOutputLines } from "../../fixtures/rpc-classic-harness.ts";
import { resetScriptedSdk, SCRIPTED_PROVIDER, sdkMessage } from "../../helpers/anthropic-subscription-scripted-sdk.ts";

const rpcIo = {
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
};

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (chunk: string) => {
		rpcIo.outputLines.push(chunk);
	},
}));

vi.mock("../../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	MAX_RPC_LINE_CHARACTERS: 16 * 1024 * 1024,
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

const DEFAULTS = { provider: SCRIPTED_PROVIDER, model: "claude-sonnet-5-5" };
const WORK_DIR_ID = "a".repeat(32);
const OTHER_DIR_ID = "b".repeat(32);

type Turn = "ok" | "auth_error";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
	setMaxListeners(0, process);
	setMaxListeners(0, process.stdin);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	vi.unstubAllEnvs();
	resetScriptedSdk();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cliSlot(name: string, dirId: string, extra: Record<string, unknown> = {}): AccountSlot {
	return { name, source: "login", store: "claude-cli", dirId, ...extra } as AccountSlot;
}

function fakeQuery(turn: Turn, queries: Options[], duringTurn?: () => Promise<void>): SdkQuery {
	return ({ options }) => {
		queries.push(options ?? {});
		const messages =
			turn === "auth_error"
				? [
						sdkMessage({
							type: "assistant",
							error: "authentication_failed",
							message: {
								id: "m",
								type: "message",
								role: "assistant",
								content: [{ type: "text", text: "Invalid" }],
							},
							parent_tool_use_id: null,
							uuid: "a",
							session_id: "s",
						}),
					]
				: [sdkMessage({ type: "result", subtype: "success", is_error: false, result: "OK", session_id: "s" })];
		const iterator = messages[Symbol.iterator]();
		let started = false;
		return {
			[Symbol.asyncIterator]() {
				return this;
			},
			async next() {
				if (!started) {
					started = true;
					await duringTurn?.();
				}
				return iterator.next();
			},
			async interrupt() {
				return {};
			},
			close() {},
			async initializationResult() {
				return {
					account: {
						tokenSource: "none",
						apiProvider: "firstParty",
						email: "user@example.com",
						organization: "Fixture Org",
						subscriptionType: "max",
					},
				};
			},
		} as unknown as ReturnType<SdkQuery>;
	};
}

async function startLane(options: {
	turn: Turn;
	pinned?: string;
	work?: Record<string, unknown>;
	other?: Record<string, unknown>;
	duringTurn?: (store: CredentialStore) => Promise<void>;
}) {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	const root = mkdtempSync(join(tmpdir(), "senpi-4436-test-provider-account-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sharedRoot = join(root, "shared-claude");
	mkdirSync(agentDir);
	mkdirSync(sharedRoot);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: DEFAULTS.provider, defaultModel: DEFAULTS.model }),
	);
	// A plain file: the executable resolver only checks it exists, and the scripted SDK never spawns it.
	const executable = join(root, "claude-stub");
	writeFileSync(executable, "not a program\n", { mode: 0o644 });
	vi.stubEnv("SENPI_CODING_AGENT_DIR", agentDir);

	const host = await createFakeRuntimeHost({ withSwapSession: false, withAuth: true, responseDelayMs: 0 });
	cleanups.push(host.cleanup);
	const store = host.runtimeHost.session.modelRegistry.authStorage as unknown as CredentialStore;
	await store.modify(SCRIPTED_PROVIDER, async () => ({
		...[
			cliSlot("work", WORK_DIR_ID, options.work),
			cliSlot("other", OTHER_DIR_ID, options.other ?? { blockReason: "rate_limit" }),
		].reduce<AnthropicSubscriptionCredential>(addAccount, emptyCredential()),
		...(options.pinned === undefined ? {} : { pinned: options.pinned }),
	}));
	const statusProbes: string[] = [];
	overrideAuthLaneBoundary({
		createStore: () => store,
		claudeCliAuthStatus: async (configDir) => {
			statusProbes.push(configDir);
			return { state: "signed_in" } as never;
		},
		env: () => ({ PATH: "/usr/bin", HOME: root, CLAUDE_CONFIG_DIR: sharedRoot, CLAUDE_CODE_EXECUTABLE: executable }),
		getAgentDir: () => agentDir,
	});
	const queries: Options[] = [];
	const duringTurn = options.duringTurn;
	overrideSdkBoundary({
		query: fakeQuery(options.turn, queries, duringTurn === undefined ? undefined : () => duringTurn(store)),
	});

	void runRpcMode(host.runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	const send = async (command: Record<string, unknown>): Promise<ParsedOutputLine> => {
		const id = `c-${Math.random().toString(36).slice(2, 10)}`;
		const lineHandler = rpcIo.lineHandler;
		if (lineHandler === undefined) throw new Error("the RPC line handler is not registered");
		lineHandler(JSON.stringify({ id, ...command }));
		const find = () =>
			parseOutputLines(rpcIo.outputLines).find((record) => record.id === id && record.type === "response");
		await vi.waitFor(() => expect(find()).toBeDefined(), { timeout: 10_000 });
		const response = find();
		if (response === undefined) throw new Error(`no response for ${id}`);
		return response;
	};
	const slots = async () =>
		((await store.read(SCRIPTED_PROVIDER)) as AnthropicSubscriptionCredential | undefined)?.accounts ?? [];
	const stored = async () => (await store.read(SCRIPTED_PROVIDER)) as AnthropicSubscriptionCredential | undefined;
	return { agentDir, queries, send, slots, stored, statusProbes };
}

describe("senpi#4436 test_provider_account re-tests one Claude CLI account", () => {
	it("test_provider_account runs one pinned turn on the named slot and returns check", async () => {
		const lane = await startLane({ turn: "ok", pinned: "other" });
		const response = await lane.send({ type: "test_provider_account", provider: SCRIPTED_PROVIDER, name: "work" });

		expect(response).toMatchObject({ command: "test_provider_account", success: true });
		const check = (response.data as { check: Record<string, unknown> }).check;
		expect(check).toMatchObject({ model: connectionTestModel(DEFAULTS), outcome: "ok" });
		expect(typeof check.at).toBe("number");
		expect(lane.queries).toHaveLength(1);
		expect(lane.queries[0]).toMatchObject({
			model: connectionTestModel(DEFAULTS),
			maxTurns: 1,
			tools: [],
			settingSources: [],
			persistSession: false,
		});
		expect(lane.queries[0]?.env?.CLAUDE_CONFIG_DIR).toBe(accountDirFor(lane.agentDir, WORK_DIR_ID));
		const work = (await lane.slots()).find((slot) => slot.name === "work");
		expect(work?.store === "claude-cli" ? work.check : undefined).toEqual(check);
		expect((await lane.stored())?.pinned).toBe("other");
		const listing = await lane.send({ type: "get_provider_accounts", provider: SCRIPTED_PROVIDER });
		const listed = (listing.data as { accounts: { name: string; check?: unknown }[] }).accounts;
		expect(listed.find((account) => account.name === "work")?.check).toEqual(check);
	});

	it("a 401 on that slot gives outcome failed reason auth and touches no other slot", async () => {
		const lane = await startLane({ turn: "auth_error" });
		const before = (await lane.slots()).find((slot) => slot.name === "other");
		const response = await lane.send({ type: "test_provider_account", provider: SCRIPTED_PROVIDER, name: "work" });

		expect(response).toMatchObject({ command: "test_provider_account", success: true });
		expect((response.data as { check: Record<string, unknown> }).check).toMatchObject({
			model: connectionTestModel(DEFAULTS),
			outcome: "failed",
			reason: "auth_error",
		});
		expect(lane.queries).toHaveLength(1);
		const after = await lane.slots();
		expect(after.find((slot) => slot.name === "other")).toEqual(before);
		const work = after.find((slot) => slot.name === "work");
		expect(work).toMatchObject({ name: "work", store: "claude-cli", dirId: WORK_DIR_ID });
		expect(work).not.toHaveProperty("blockReason");
		expect(work).not.toHaveProperty("blockedUntil");
		expect(work).not.toHaveProperty("blockedAt");
	});

	it("a blocked account is still tested, keeps its block, and no other account is re-probed", async () => {
		const block = { blockedUntil: 4_102_444_000_000, blockReason: "auth_error", blockedAt: 1 };
		const lane = await startLane({
			turn: "ok",
			work: block,
			other: { blockedUntil: 1, blockReason: "auth_error", blockedAt: 1 },
		});
		const response = await lane.send({ type: "test_provider_account", provider: SCRIPTED_PROVIDER, name: "work" });

		expect((response.data as { check: Record<string, unknown> }).check).toMatchObject({ outcome: "ok" });
		expect(lane.queries).toHaveLength(1);
		expect(lane.queries[0]?.env?.CLAUDE_CONFIG_DIR).toBe(accountDirFor(lane.agentDir, WORK_DIR_ID));
		expect(lane.statusProbes).toEqual([]);
		const after = await lane.slots();
		expect(after.find((slot) => slot.name === "work")).toMatchObject(block);
		expect(after.find((slot) => slot.name === "other")).toMatchObject({ blockReason: "auth_error", blockedUntil: 1 });
	});

	it("a block another session stores during the test stays", async () => {
		const elsewhere = { blockedUntil: 4_102_444_000_000, blockReason: "billing", blockedAt: 2 };
		const lane = await startLane({
			turn: "ok",
			duringTurn: async (store) => {
				await store.modify(SCRIPTED_PROVIDER, async (current) => {
					const credential = current as AnthropicSubscriptionCredential;
					return {
						...credential,
						accounts: (credential.accounts ?? []).map((slot) =>
							slot.name === "work" ? { ...slot, ...elsewhere } : slot,
						),
					};
				});
			},
		});
		await lane.send({ type: "test_provider_account", provider: SCRIPTED_PROVIDER, name: "work" });

		const work = (await lane.slots()).find((slot) => slot.name === "work");
		expect(work).toMatchObject({ ...elsewhere, check: { outcome: "ok" } });
	});

	it("an unknown account answers unknown_account and another provider unsupported_provider, with no turn", async () => {
		const lane = await startLane({ turn: "ok" });
		const unknown = await lane.send({ type: "test_provider_account", provider: SCRIPTED_PROVIDER, name: "nope" });
		expect(unknown).toMatchObject({ command: "test_provider_account", success: false, error: "unknown_account" });
		const other = await lane.send({ type: "test_provider_account", provider: "openai", name: "work" });
		expect(other).toMatchObject({ command: "test_provider_account", success: false, error: "unsupported_provider" });
		expect(lane.queries).toHaveLength(0);
	});

	it("an account that must sign in again answers needs_sign_in, with no turn and no write", async () => {
		const lane = await startLane({ turn: "ok", work: { signInRequired: "legacy_sign_in_retired" } });
		const before = await lane.slots();
		const response = await lane.send({ type: "test_provider_account", provider: SCRIPTED_PROVIDER, name: "work" });

		expect(response).toMatchObject({ command: "test_provider_account", success: false, error: "needs_sign_in" });
		expect(lane.queries).toHaveLength(0);
		expect(await lane.slots()).toEqual(before);
	});

	it("capability provider_account_test is advertised", async () => {
		const lane = await startLane({ turn: "ok" });
		const classic = await lane.send({ type: "get_protocol_info" });
		expect((classic.data as { capabilities: string[] }).capabilities).toContain(PROVIDER_ACCOUNT_TEST_CAPABILITY);
		const router = new SessionCommandRouter({ list: () => [] } as never, new SessionEventWriter(() => {}), {
			cwd: "/tmp",
		});
		const multi = await router.handle({ id: "probe", type: "get_protocol_info" });
		expect((multi as { data: { capabilities: string[] } }).data.capabilities).toContain(
			PROVIDER_ACCOUNT_TEST_CAPABILITY,
		);
		expect(PROVIDER_ACCOUNT_TEST_CAPABILITY).toBe("provider_account_test");
	});
});
