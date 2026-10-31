/**
 * senpi#4436 (S5): `/login anthropic-subscription` signs in through `claude auth login --claudeai` into the
 * account's own config dir, stores a CLI-store slot with the profile `claude auth status` reports, keeps the
 * prompt titles clients match, and runs one pinned connection-test turn on the default profile's Claude model.
 */
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	AccountSlot,
	AnthropicSubscriptionCredential,
} from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { addAccount, emptyCredential } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import { overrideAuthLaneBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/auth-lane.ts";
import { readClaudeCliAuthStatus } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-auth-status.ts";
import { connectionTestModel } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-connection-test.ts";
import { takeClaudeCliLoginOutcome } from "../../../src/core/extensions/builtin/anthropic-subscription/claude-cli-login-outcome.ts";
import {
	type ClaudeCliLoginDeps,
	createOAuthConfig,
	type OAuthLoginCallbacks,
} from "../../../src/core/extensions/builtin/anthropic-subscription/oauth-login.ts";
import type { Options, SdkQuery } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { overrideSdkBoundary } from "../../../src/core/extensions/builtin/anthropic-subscription/sdk-boundary.ts";
import { resetScriptedSdk, SCRIPTED_PROVIDER, sdkMessage } from "../../helpers/anthropic-subscription-scripted-sdk.ts";
import { composedProvider } from "../../support/anthropic-subscription-provider.ts";

const FIXTURE = join(import.meta.dirname, "..", "..", "fixtures", "claude-cli-auth", "fake-claude.mjs");
const DEFAULTS = { provider: "anthropic-subscription", model: "claude-sonnet-5-5" };
// Desktop machine values (omoLoginDialogs.ts), copied as literals so a rename here fails this test.
const DESKTOP_METHOD_TITLE = "Select Anthropic login method:";
const DESKTOP_METHOD_LABELS = ["Browser login (default)", "Copy code login (headless)"];
const DESKTOP_NAME_PREFIX = "Name for this account (";
const DESKTOP_PASTE_TITLE = "Paste the code Anthropic shows after you sign in:";

const roots: string[] = [];

afterEach(() => {
	resetScriptedSdk();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Recorded = { argv?: string[]; configDir?: string; stdin?: string };
type Turn = "ok" | "auth_error";

/** An existing account's dir on disk, with a file only that dir holds. */
function seedAccountDir(agentDir: string, dirId: string): string {
	const dir = join(agentDir, "anthropic-subscription-claude", dirId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "old-login-marker"), "old");
	return dir;
}

function cliSlot(name: string, dirId: string, extra: Record<string, unknown> = {}): AccountSlot {
	return { name, source: "login", store: "claude-cli", dirId, ...extra } as AccountSlot;
}

async function setup(options: {
	mode?: string;
	slots?: AccountSlot[];
	pinned?: string;
	order?: string[];
	turn?: Turn;
	onQuery?: () => void;
	cli?: (store: InMemoryCredentialStore) => Partial<ClaudeCliLoginDeps>;
	env?: Record<string, string>;
}) {
	const root = mkdtempSync(join(tmpdir(), "senpi-4436-login-via-cli-"));
	roots.push(root);
	const agentDir = join(root, "agent");
	const sharedRoot = join(root, "shared-claude");
	mkdirSync(agentDir);
	mkdirSync(sharedRoot);
	const executable = join(root, "claude");
	copyFileSync(FIXTURE, executable);
	chmodSync(executable, 0o755);
	const recordPath = join(root, "record.jsonl");
	const store = new InMemoryCredentialStore();
	const seededSlots = options.slots;
	if (seededSlots) {
		await store.modify(SCRIPTED_PROVIDER, async () => ({
			...seededSlots.reduce<AnthropicSubscriptionCredential>(addAccount, emptyCredential()),
			...(options.pinned === undefined ? {} : { pinned: options.pinned }),
			...(options.order === undefined ? {} : { order: options.order }),
		}));
	}
	overrideAuthLaneBoundary({
		createStore: () => store,
		env: () => ({
			PATH: process.env.PATH ?? "/usr/bin",
			HOME: root,
			CLAUDE_CONFIG_DIR: sharedRoot,
			FAKE_CLAUDE_MODE: options.mode ?? "login-auto",
			FAKE_CLAUDE_STATUS_MODE: "status-claudeai",
			FAKE_CLAUDE_RECORD: recordPath,
			...options.env,
		}),
		getAgentDir: () => agentDir,
	});
	const queries: Options[] = [];
	const query: SdkQuery = ({ options: queryOptions }) => {
		queries.push(queryOptions ?? {});
		options.onQuery?.();
		const messages =
			options.turn === "auth_error"
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
		return Object.assign(
			{
				[Symbol.asyncIterator]() {
					return this;
				},
				async next() {
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
			},
			{},
		) as unknown as ReturnType<SdkQuery>;
	};
	overrideSdkBoundary({ query });
	const loginFlow = { name: "pkce-spy", login: vi.fn(), refresh: vi.fn(), toAuth: vi.fn() };
	const config = createOAuthConfig({
		readCurrent: async () => (await store.read(SCRIPTED_PROVIDER)) as AnthropicSubscriptionCredential | undefined,
		loginFlow,
		claudeCli: {
			executable: () => executable,
			defaultModel: () => DEFAULTS,
			cwd: () => root,
			...options.cli?.(store),
		},
	} as Parameters<typeof createOAuthConfig>[0]);
	const records = (): Recorded[] =>
		existsSync(recordPath)
			? readFileSync(recordPath, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as Recorded)
			: [];
	const slots = async () =>
		((await store.read(SCRIPTED_PROVIDER)) as AnthropicSubscriptionCredential | undefined)?.accounts ?? [];
	const accountDirs = () => {
		const parent = join(agentDir, "anthropic-subscription-claude");
		return existsSync(parent) ? readdirSync(parent) : [];
	};
	return { agentDir, config, loginFlow, records, slots, store, queries, accountDirs };
}

function heldOpen(prompt: { signal?: AbortSignal }): Promise<string> {
	return new Promise((_resolve, reject) =>
		prompt.signal?.addEventListener("abort", () => reject(new Error("released")), { once: true }),
	);
}

describe("senpi#4436 sign-in runs claude auth login, then the connection test", () => {
	it("T1 login never calls the hand-rolled flow", async () => {
		const lane = await setup({});
		await lane.config.login({ onPrompt: heldOpen });
		expect(lane.loginFlow.login).not.toHaveBeenCalled();
		const login = lane.records().find((record) => record.argv?.[1] === "login");
		expect(login?.argv).toEqual(["auth", "login", "--claudeai"]);
		expect(login?.configDir).toContain(join(lane.agentDir, "anthropic-subscription-claude"));
	});

	it("T2 the produced slot is store claude-cli with profile from auth status", async () => {
		const lane = await setup({});
		const signal = new AbortController().signal;
		const credential = (await lane.config.login({ onPrompt: heldOpen, signal })) as AnthropicSubscriptionCredential;
		const [slot] = credential.accounts ?? [];
		expect(slot).toMatchObject({
			name: "default",
			source: "login",
			store: "claude-cli",
			profile: { email: "user@example.com", orgName: "Fixture Org", subscriptionType: "max" },
		});
		expect(slot?.store === "claude-cli" && slot.dirId).toMatch(/^[0-9a-f]{32}$/);
		expect(slot?.store === "claude-cli" && typeof slot.signedInAt).toBe("number");
		expect(lane.records().find((record) => record.argv?.[1] === "login")?.configDir).toBe(
			join(lane.agentDir, "anthropic-subscription-claude", slot?.store === "claude-cli" ? slot.dirId : ""),
		);
		// The account owns its dir from the first write on; the caller's commit merges onto it.
		expect(await lane.slots()).toEqual(credential.accounts);
		expect(takeClaudeCliLoginOutcome(signal)).toMatchObject({
			account: { name: "default" },
			check: { outcome: "ok" },
		});
	});

	it("T3 Reconnect keeps name, pin and order, signs into a fresh dir and retires the old one", async () => {
		const oldDirId = "c".repeat(32);
		const lane = await setup({
			slots: [
				cliSlot("other", "d".repeat(32)),
				cliSlot("work", oldDirId, {
					displayName: "Work",
					signInRequired: "legacy_sign_in_retired",
					blockReason: "auth_error",
					blockedUntil: Date.now() + 60_000,
				}),
			],
			pinned: "work",
			order: ["other", "work"],
		});
		const oldDir = seedAccountDir(lane.agentDir, oldDirId);
		const credential = (await lane.config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith(DESKTOP_NAME_PREFIX) ? "work" : heldOpen(prompt)),
		})) as AnthropicSubscriptionCredential;
		expect(credential.pinned).toBe("work");
		expect(credential.order).toEqual(["other", "work"]);
		expect(credential.accounts?.map((slot) => slot.name)).toEqual(["other", "work"]);
		const work = credential.accounts?.find((slot) => slot.name === "work");
		expect(work).toMatchObject({ store: "claude-cli", displayName: "Work" });
		expect(work).not.toHaveProperty("signInRequired");
		expect(work).not.toHaveProperty("blockReason");
		const freshDirId = work?.store === "claude-cli" ? work.dirId : "";
		expect(freshDirId).toMatch(/^[0-9a-f]{32}$/);
		expect(freshDirId).not.toBe(oldDirId);
		const accountDir = (dirId: string) => join(lane.agentDir, "anthropic-subscription-claude", dirId);
		expect(lane.records().find((record) => record.argv?.[1] === "login")?.configDir).toBe(accountDir(freshDirId));
		expect(
			lane
				.records()
				.filter((record) => record.argv?.join(" ") === "auth logout")
				.map((record) => record.configDir),
		).toEqual([oldDir]);
		expect(lane.accountDirs()).toEqual([freshDirId]);
	});

	it("T4 the prompt titles stay the machine values the desktop matches", async () => {
		const lane = await setup({ mode: "login-paste", slots: [cliSlot("default", "e".repeat(32))] });
		const seen: { select?: { message: string; labels: string[] }; prompts: string[]; pastePlaceholder?: string } = {
			prompts: [],
		};
		const urls: string[] = [];
		const callbacks: OAuthLoginCallbacks = {
			onSelect: async (prompt) => {
				seen.select = { message: prompt.message, labels: prompt.options.map((option) => option.label) };
				return prompt.options.find((option) => option.label === DESKTOP_METHOD_LABELS[1])?.id;
			},
			onPrompt: async (prompt) => {
				seen.prompts.push(prompt.message);
				if (prompt.message.startsWith(DESKTOP_NAME_PREFIX)) return "second";
				seen.pastePlaceholder = prompt.placeholder;
				return "fixture-code#fixture-state";
			},
			onAuth: ({ url }) => {
				urls.push(url);
			},
		};
		await lane.config.login(callbacks);
		expect(seen.select).toEqual({ message: DESKTOP_METHOD_TITLE, labels: DESKTOP_METHOD_LABELS });
		expect(seen.prompts[0]?.startsWith(DESKTOP_NAME_PREFIX)).toBe(true);
		expect(seen.prompts[1]).toBe(DESKTOP_PASTE_TITLE);
		expect(seen.pastePlaceholder).toMatch(/^https:\/\/claude\.ai\/oauth\/authorize\?.*platform\.claude\.com/);
		expect(urls).toEqual([seen.pastePlaceholder]);
		expect(lane.records().find((record) => record.stdin !== undefined)?.stdin).toBe("fixture-code#fixture-state");
	});

	it("T5 the connection test uses the default profile's Claude model with accountFallback false", async () => {
		const lane = await setup({});
		const credential = (await lane.config.login({ onPrompt: heldOpen })) as AnthropicSubscriptionCredential;
		expect(lane.queries.map((options) => options.model)).toEqual([connectionTestModel(DEFAULTS)]);
		expect(lane.queries[0]).toMatchObject({ maxTurns: 1, tools: [], settingSources: [], persistSession: false });
		expect(credential.accounts?.[0]).toMatchObject({
			check: { model: connectionTestModel(DEFAULTS), outcome: "ok" },
		});
	});

	it("T5 a failed test keeps the account with check.outcome failed", async () => {
		const lane = await setup({ slots: [cliSlot("other", "f".repeat(32))], turn: "auth_error" });
		const credential = (await lane.config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith(DESKTOP_NAME_PREFIX) ? "fresh" : heldOpen(prompt)),
		})) as AnthropicSubscriptionCredential;
		expect(lane.queries).toHaveLength(1);
		const fresh = credential.accounts?.find((slot) => slot.name === "fresh");
		expect(fresh).toMatchObject({ store: "claude-cli", check: { outcome: "failed" } });
		expect(fresh?.store === "claude-cli" ? fresh.check?.reason : undefined).toBeTruthy();
	});

	it("T6 a login cancelled during provider_login_start never spawns claude", async () => {
		const lane = await setup({});
		const controller = new AbortController();
		controller.abort();
		await expect(lane.config.login({ onPrompt: heldOpen, signal: controller.signal })).rejects.toThrow(/cancelled/i);
		expect(lane.records()).toEqual([]);
		expect(lane.accountDirs()).toEqual([]);
	});

	it("T6 a login cancelled mid-flow removes the new account dir", async () => {
		const lane = await setup({ mode: "login-hang" });
		const controller = new AbortController();
		const login = lane.config.login({
			onPrompt: heldOpen,
			onAuth: () => controller.abort(),
			signal: controller.signal,
		});
		await expect(login).rejects.toThrow(/cancelled/i);
		expect(lane.records().some((record) => record.argv?.[1] === "login")).toBe(true);
		expect(lane.accountDirs()).toEqual([]);
		expect(await lane.slots()).toEqual([]);
	});
});

type CancelStage = "sign-in" | "status read" | "first write" | "connection test";

describe("senpi#4436 a login cancelled at any stage leaves no account and no account dir", () => {
	const rows: Array<{ stage: CancelStage; signedIn: boolean }> = [
		// The CLI login process was started, so the rollback signs its dir out even though it never reported success.
		{ stage: "sign-in", signedIn: true },
		{ stage: "status read", signedIn: true },
		{ stage: "first write", signedIn: true },
		{ stage: "connection test", signedIn: true },
	];

	it.each(rows)("cancel during $stage", async ({ stage, signedIn }) => {
		const controller = new AbortController();
		const lane = await setup({
			mode: stage === "sign-in" ? "login-hang" : "login-auto",
			onQuery: stage === "connection test" ? () => controller.abort() : undefined,
			cli: (store) => ({
				...(stage === "status read"
					? {
							authStatus: async (run) => {
								const status = await readClaudeCliAuthStatus(run);
								controller.abort();
								return status;
							},
						}
					: {}),
				...(stage === "first write"
					? {
							store: () => ({
								read: (provider) => store.read(provider),
								list: () => store.list(),
								delete: (provider) => store.delete(provider),
								modify: async (provider, update) => {
									const written = await store.modify(provider, update);
									controller.abort();
									return written;
								},
							}),
						}
					: {}),
			}),
		});
		const login = lane.config.login({
			onPrompt: heldOpen,
			...(stage === "sign-in" ? { onAuth: () => controller.abort() } : {}),
			signal: controller.signal,
		});

		await expect(login).rejects.toThrow(/cancelled/i);
		expect(await lane.slots()).toEqual([]);
		expect(lane.accountDirs()).toEqual([]);
		const signedOut = lane.records().some((record) => record.argv?.join(" ") === "auth logout");
		expect(signedOut).toBe(signedIn);
	});
});

describe("senpi#4436 a cancelled re-login leaves the existing account as it was", () => {
	it("re-login under an existing CLI name succeeds through the fresh-dir swap, not the token-slot upsert", async () => {
		const oldDirId = "b".repeat(32);
		const lane = await setup({ slots: [cliSlot("work", oldDirId), cliSlot("other", "e".repeat(32))] });
		seedAccountDir(lane.agentDir, oldDirId);

		const credential = (await lane.config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith(DESKTOP_NAME_PREFIX) ? "work" : heldOpen(prompt)),
		})) as AnthropicSubscriptionCredential;

		const work = credential.accounts?.find((slot) => slot.name === "work");
		expect(work?.store).toBe("claude-cli");
		expect(work?.store === "claude-cli" ? work.dirId : oldDirId).not.toBe(oldDirId);
		expect(credential.accounts?.map((slot) => slot.name)).toEqual(["work", "other"]);
	});

	it("re-login cancelled after its CLI login finished: old slot and old dir unchanged, fresh dir gone", async () => {
		const oldDirId = "a".repeat(32);
		const existing = cliSlot("work", oldDirId, { profile: { email: "old@example.com", checkedAt: 1 } });
		const controller = new AbortController();
		const lane = await setup({
			slots: [existing],
			cli: () => ({
				authStatus: async (run) => {
					const status = await readClaudeCliAuthStatus(run);
					controller.abort();
					return status;
				},
			}),
		});
		const oldDir = seedAccountDir(lane.agentDir, oldDirId);

		const login = lane.config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith(DESKTOP_NAME_PREFIX) ? "work" : heldOpen(prompt)),
			signal: controller.signal,
		});

		await expect(login).rejects.toThrow(/cancelled/i);
		expect(await lane.slots()).toEqual([existing]);
		expect(readFileSync(join(oldDir, "old-login-marker"), "utf8")).toBe("old");
		expect(lane.accountDirs()).toEqual([oldDirId]);
		const loginDir = lane.records().find((record) => record.argv?.[1] === "login")?.configDir;
		expect(loginDir).not.toBe(oldDir);
		expect(
			lane
				.records()
				.filter((record) => record.argv?.join(" ") === "auth logout")
				.map((record) => record.configDir),
		).toEqual([loginDir]);
	});
});

describe("senpi#4436 no Claude CLI login outlives the account that owns it", () => {
	const loginDirs = (records: Recorded[]) =>
		records.filter((record) => record.argv?.[1] === "login").map((record) => record.configDir);
	const logoutDirs = (records: Recorded[]) =>
		records.filter((record) => record.argv?.join(" ") === "auth logout").map((record) => record.configDir);

	it("a sign-in that fails after the CLI saved its login signs that dir out and removes it", async () => {
		const lane = await setup({ mode: "login-exit0-silent" });

		const login = lane.config.login({ onPrompt: async () => "fixture-code#fixture-state" });

		await expect(login).rejects.toThrow(/sign-in failed/i);
		expect(await lane.slots()).toEqual([]);
		expect(lane.accountDirs()).toEqual([]);
		expect(logoutDirs(lane.records())).toEqual(loginDirs(lane.records()));
	});

	it("a cancel at the final commit never leaves a signed-in dir without a slot that owns it", async () => {
		const controller = new AbortController();
		const lane = await setup({});
		const models = createModels({
			credentials: {
				read: (provider) => lane.store.read(provider),
				list: () => lane.store.list(),
				delete: (provider) => lane.store.delete(provider),
				modify: async (provider, update, options) => {
					// Only the login commit passes a signal: the user cancels exactly as it starts.
					if (options?.signal !== undefined) {
						controller.abort();
						throw new Error("commit interrupted");
					}
					return lane.store.modify(provider, update);
				},
			},
		});
		models.setProvider(composedProvider(async () => false, { oauth: lane.config }));

		const login = models.login("anthropic-subscription", "oauth", {
			signal: controller.signal,
			prompt: async (prompt) => (prompt.type === "select" ? (prompt.options?.[0]?.id ?? "") : heldOpen(prompt)),
			notify: () => {},
		});

		await expect(login).rejects.toThrow();
		const owned = (await lane.slots()).flatMap((slot) => (slot.store === "claude-cli" ? [slot.dirId] : []));
		expect(lane.accountDirs().filter((dirId) => !owned.includes(dirId))).toEqual([]);
		expect(owned.filter((dirId) => !lane.accountDirs().includes(dirId))).toEqual([]);
	});

	it("a sign-out that fails during the rollback is reported, and the account and dir are still gone", async () => {
		const controller = new AbortController();
		const progress: string[] = [];
		const lane = await setup({
			env: { FAKE_CLAUDE_LOGOUT_FAIL: "1" },
			cli: () => ({
				authStatus: async (run) => {
					const status = await readClaudeCliAuthStatus(run);
					controller.abort();
					return status;
				},
			}),
		});

		const login = lane.config.login({
			onPrompt: heldOpen,
			onProgress: (message) => progress.push(message),
			signal: controller.signal,
		});

		await expect(login).rejects.toThrow(/cancelled/i);
		expect(await lane.slots()).toEqual([]);
		expect(lane.accountDirs()).toEqual([]);
		expect(progress.filter((message) => /could not be signed out/i.test(message))).toHaveLength(1);
	});

	it("a re-login cancelled while another write updates the slot keeps that write", async () => {
		const oldDirId = "a".repeat(32);
		const blockedUntil = Date.now() + 3_600_000;
		const controller = new AbortController();
		const lane = await setup({
			slots: [cliSlot("work", oldDirId, { profile: { email: "old@example.com", checkedAt: 1 } })],
			cli: (store) => ({
				connectionTest: async ({ model }) => {
					await store.modify(SCRIPTED_PROVIDER, async (stored) => {
						const credential = stored as AnthropicSubscriptionCredential;
						return {
							...credential,
							accounts: (credential.accounts ?? []).map((slot) =>
								slot.name === "work"
									? {
											...slot,
											blockReason: "rate_limit",
											blockedUntil,
											modelBlocks: { opus: { blockedUntil } },
										}
									: slot,
							),
						};
					});
					controller.abort();
					return { model, outcome: "failed", reason: "cancelled", at: 0 };
				},
			}),
		});
		const oldDir = seedAccountDir(lane.agentDir, oldDirId);

		const login = lane.config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith(DESKTOP_NAME_PREFIX) ? "work" : heldOpen(prompt)),
			signal: controller.signal,
		});

		await expect(login).rejects.toThrow(/cancelled/i);
		const [work] = await lane.slots();
		expect(work).toMatchObject({
			name: "work",
			dirId: oldDirId,
			profile: { email: "old@example.com", checkedAt: 1 },
			blockReason: "rate_limit",
			blockedUntil,
			modelBlocks: { opus: { blockedUntil } },
		});
		expect(work).not.toHaveProperty("signedInAt");
		expect(readFileSync(join(oldDir, "old-login-marker"), "utf8")).toBe("old");
		expect(lane.accountDirs()).toEqual([oldDirId]);
	});

	it("an undone re-login takes back the profile and check another writer stored for its discarded login", async () => {
		const oldDirId = "a".repeat(32);
		const oldProfile = { email: "old@example.com", checkedAt: 1 };
		const oldCheck = { model: "claude-sonnet-5-5", outcome: "failed", reason: "auth_error", at: 1 };
		const controller = new AbortController();
		const lane = await setup({
			slots: [cliSlot("work", oldDirId, { profile: oldProfile, check: oldCheck })],
			cli: (store) => ({
				connectionTest: async ({ model }) => {
					// A turn on the fresh dir records what that dir's login reports, then the user cancels.
					await store.modify(SCRIPTED_PROVIDER, async (stored) => {
						const credential = stored as AnthropicSubscriptionCredential;
						return {
							...credential,
							accounts: (credential.accounts ?? []).map((slot) =>
								slot.name === "work"
									? {
											...slot,
											profile: { email: "fresh@example.com", checkedAt: 2 },
											check: { model, outcome: "ok", at: 2 },
										}
									: slot,
							),
						};
					});
					controller.abort();
					return { model, outcome: "failed", reason: "cancelled", at: 0 };
				},
			}),
		});
		seedAccountDir(lane.agentDir, oldDirId);

		const login = lane.config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith(DESKTOP_NAME_PREFIX) ? "work" : heldOpen(prompt)),
			signal: controller.signal,
		});

		await expect(login).rejects.toThrow(/cancelled/i);
		const [work] = await lane.slots();
		expect(work).toEqual(cliSlot("work", oldDirId, { profile: oldProfile, check: oldCheck }));
	});

	it("a write to the account while its re-login runs survives the sign-in", async () => {
		const oldDirId = "a".repeat(32);
		const blockedUntil = Date.now() + 3_600_000;
		const lane = await setup({
			slots: [cliSlot("work", oldDirId)],
			cli: (store) => ({
				authStatus: async (run) => {
					// Another client renames the account and a turn blocks a model on it while the CLI login runs.
					await store.modify(SCRIPTED_PROVIDER, async (stored) => {
						const credential = stored as AnthropicSubscriptionCredential;
						return {
							...credential,
							accounts: (credential.accounts ?? []).map((slot) =>
								slot.name === "work"
									? { ...slot, displayName: "Renamed", modelBlocks: { opus: { blockedUntil } } }
									: slot,
							),
						};
					});
					return readClaudeCliAuthStatus(run);
				},
			}),
		});
		seedAccountDir(lane.agentDir, oldDirId);

		await lane.config.login({
			onPrompt: async (prompt) => (prompt.message.startsWith(DESKTOP_NAME_PREFIX) ? "work" : heldOpen(prompt)),
		});

		const [work] = await lane.slots();
		expect(work).toMatchObject({ name: "work", displayName: "Renamed", modelBlocks: { opus: { blockedUntil } } });
		expect(work?.store === "claude-cli" ? work.dirId : oldDirId).not.toBe(oldDirId);
		expect(lane.accountDirs()).not.toContain(oldDirId);
	});
});
