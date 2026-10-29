import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessageEvent, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { AUTH_BLOCK_REPROBE_MS } from "../../../src/core/credential-pool/auth-reprobe.ts";
import { classifyCredentialFailure } from "../../../src/core/credential-pool/classify.ts";
import type { RotationSources } from "../../../src/core/credential-pool/rotation-slots.ts";
import { streamWithCredentialRotation } from "../../../src/core/credential-pool/rotation-stream.ts";
import { CredentialSlotRepository } from "../../../src/core/credential-pool/state-store.ts";
import type { AccountSlot } from "../../../src/core/extensions/builtin/anthropic-subscription/accounts.ts";
import {
	AllAccountsBlockedError,
	selectAccount,
} from "../../../src/core/extensions/builtin/anthropic-subscription/affinity.ts";
import { withAuthGuidance } from "../../../src/core/extensions/builtin/anthropic-subscription/stream-guidance.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

const NOW = 1_800_000_000_000;
const PROVIDER = "anthropic-subscription";

function innerAccount(name: string, extra: Partial<AccountSlot> = {}): AccountSlot {
	return { name, refresh: `refresh-${name}`, access: `access-${name}`, expires: NOW * 2, source: "login", ...extra };
}

/** The message the Anthropic Subscription lane reports when its own account pool refuses the request. */
function innerPoolRefusal(accounts: readonly AccountSlot[]): { error: AllAccountsBlockedError; message: string } {
	try {
		selectAccount(accounts, { now: NOW });
	} catch (error) {
		if (error instanceof AllAccountsBlockedError) return { error, message: withAuthGuidance(error, error.message) };
		throw error;
	}
	throw new Error("expected the inner account pool to refuse the request");
}

const MIXED_POOL = [
	innerAccount("revoked", { blockReason: "auth_error", blockedUntil: NOW + AUTH_BLOCK_REPROBE_MS }),
	innerAccount("limited", { blockReason: "rate_limit", blockedUntil: NOW + 60_000 }),
];

function errorEvent(message: string, httpStatus?: number): AssistantMessageEvent {
	return {
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: "anthropic-messages",
			provider: PROVIDER,
			model: "claude-sonnet",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: message,
			...(httpStatus === undefined
				? {}
				: { providerDiagnostic: { category: "unknown", httpStatus, evidence: "structured_status" } }),
			timestamp: NOW,
		},
	} as AssistantMessageEvent;
}

function doneEvent(): AssistantMessageEvent {
	const failed = errorEvent("");
	if (failed.type !== "error") throw new Error("expected an error event");
	return { type: "done", reason: "stop", message: { ...failed.error, stopReason: "stop" } };
}

describe("transient failures never poison credential slots (senpi#2081)", () => {
	let dir: string;
	let repository: CredentialSlotRepository;
	let clock: number;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "slots-2081-"));
		repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
		clock = NOW;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function sources(): RotationSources {
		return {
			providerId: PROVIDER,
			credential: {
				type: "oauth",
				access: "access-pinned",
				refresh: "refresh-pinned",
				expires: NOW * 2,
				accounts: [
					{
						name: "pinned",
						access: "access-pinned",
						refresh: "refresh-pinned",
						expires: NOW * 2,
						source: "login",
					},
					{ name: "other", access: "access-other", refresh: "refresh-other", expires: NOW * 2, source: "login" },
				],
			} as RotationSources["credential"],
			env: () => undefined,
			repository,
			now: () => clock,
		};
	}

	async function request(attempt: () => AssistantMessageEvent): Promise<{ events: AssistantMessageEvent[] }> {
		const events: AssistantMessageEvent[] = [];
		const stream = streamWithCredentialRotation({
			sources: sources(),
			affinityKey: "session-2081",
			runAttempt: async function* () {
				yield attempt();
			},
		});
		for await (const event of stream) events.push(event);
		return { events };
	}

	async function persistedReasons(): Promise<Record<string, string | undefined>> {
		const slots = await repository.listSlots(PROVIDER, "stored");
		return Object.fromEntries(Object.entries(slots).map(([name, state]) => [name, state.blockReason]));
	}

	test("(a) the inner pool's all-accounts verdict on every slot recovers once the real deadline passes, with no re-login", async () => {
		const refusal = innerPoolRefusal(MIXED_POOL);
		await request(() => errorEvent(refusal.message));

		// The inner limit lifted after 60 s; the same credentials, sessions and sidecar must serve again.
		clock = NOW + 2 * 60_000;
		const { events } = await request(() => doneEvent());

		expect(events.at(-1)?.type).toBe("done");
		expect(Object.values(await persistedReasons())).not.toContain("auth_error");
	});

	test("(a) a server fault whose body mentions authorization stays a same-slot retry and never blocks a slot", async () => {
		await request(() => errorEvent("503 Service Unavailable: upstream unauthorized, try again", 503));

		const { events } = await request(() => doneEvent());

		expect(events.at(-1)?.type).toBe("done");
		expect(await persistedReasons()).toEqual({});
	});

	test("(a) a 429 whose body mentions an authentication error cools down instead of blocking until re-login", async () => {
		await request(() => errorEvent("429 Too Many Requests: authentication_error upstream retry later", 429));

		expect(Object.values(await persistedReasons())).not.toContain("auth_error");
		clock = NOW + 24 * 60 * 60_000;
		const { events } = await request(() => doneEvent());
		expect(events.at(-1)?.type).toBe("done");
	});

	test("(b) a mixed revoked + rate-limited pool never reports or persists auth_error for the limited account", async () => {
		const refusal = innerPoolRefusal(MIXED_POOL);

		expect(refusal.error.blockReason).toBeUndefined();
		expect(refusal.error.soonestUnblockAt).toBe(NOW + 60_000);
		expect(classifyCredentialFailure(new Error(refusal.message), { nowMs: NOW })).not.toMatchObject({
			block: { reason: "auth_error" },
		});

		await request(() => errorEvent(refusal.message));
		expect(Object.values(await persistedReasons())).not.toContain("auth_error");
	});

	test("(c) a genuine 401 auth rejection still blocks the slot until its re-probe, and the refusal names it", async () => {
		const rejected = () => errorEvent('401 {"type":"error","error":{"type":"authentication_error"}}', 401);
		await request(rejected);

		expect(await persistedReasons()).toEqual({ pinned: "auth_error", other: "auth_error" });

		clock = NOW + 60_000;
		let thrown: unknown;
		try {
			await request(() => doneEvent());
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = thrown instanceof Error ? thrown.message : "";
		const recheck = new Date(NOW + AUTH_BLOCK_REPROBE_MS).toISOString();
		expect(message).toContain(`pinned (auth_error until ${recheck})`);
		expect(message).toContain(`other (auth_error until ${recheck})`);
	});
});

describe("a provider that selects its own accounts is never wrapped by the generic pool (senpi#2081)", () => {
	const LANE = "lane-provider";
	let dir: string;
	let clock: number;
	let laneAccounts: AccountSlot[];
	/** What the lane's chosen account answers; undefined serves the turn. */
	let laneAnswer: (account: AccountSlot) => string | undefined;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "lane-2081-"));
		clock = NOW;
		laneAnswer = () => undefined;
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	async function laneRuntime(): Promise<ModelRuntime> {
		const credentials = AuthStorage.inMemory({
			[LANE]: {
				type: "oauth",
				access: "access-pinned",
				refresh: "refresh-pinned",
				expires: NOW * 2,
				accounts: [
					{
						name: "pinned",
						access: "access-pinned",
						refresh: "refresh-pinned",
						expires: NOW * 2,
						source: "login",
					},
					{ name: "other", access: "access-other", refresh: "refresh-other", expires: NOW * 2, source: "login" },
				],
			},
		});
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, agentDir: dir });
		runtime.registerProvider(LANE, {
			name: "Lane",
			baseUrl: "https://lane.invalid/v1",
			api: "openai-completions",
			ownsAccountSelection: true,
			oauth: {
				name: "Lane subscription",
				login: async () => ({ access: "access-pinned", refresh: "refresh-pinned", expires: NOW * 2 }),
				refreshToken: async (credential) => credential,
				getApiKey: (credential) => credential.access,
			},
			// The lane picks from ALL its accounts itself, like the Anthropic Subscription lane.
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				void Promise.resolve().then(() => {
					let failure: string | undefined;
					try {
						const account = selectAccount(laneAccounts, { now: clock, pinnedAccount: "pinned" });
						failure = laneAnswer(account);
					} catch (error) {
						if (!(error instanceof AllAccountsBlockedError)) throw error;
						failure = withAuthGuidance(error, error.message);
					}
					const done = errorEvent("");
					if (done.type !== "error") throw new Error("expected an error event");
					stream.push(
						failure === undefined
							? { type: "done", reason: "stop", message: { ...done.error, provider: LANE, stopReason: "stop" } }
							: { ...done, error: { ...done.error, provider: LANE, errorMessage: failure } },
					);
				});
				return stream;
			},
			models: [
				{
					id: "lane-model",
					name: "lane-model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 10_000,
					maxTokens: 1_000,
				},
			],
		});
		return runtime;
	}

	async function laneRequest(runtime: ModelRuntime): Promise<AssistantMessageEvent | undefined> {
		const model = runtime.getModel(LANE, "lane-model");
		if (model === undefined) throw new Error("lane model not registered");
		let last: AssistantMessageEvent | undefined;
		for await (const event of runtime.streamSimple(model, { messages: [] }, { sessionId: "session-2081" })) {
			last = event;
			if (event.type === "done" || event.type === "error") break;
		}
		return last;
	}

	async function outerSlotStates(): Promise<Record<string, unknown>> {
		return new CredentialSlotRepository(join(dir, "credential-pool-state.json")).listSlots(LANE, "stored");
	}

	test("(a) a lane with one auth-blocked and one rate-limited account leaves no slot blocked as auth_error", async () => {
		laneAccounts = [...MIXED_POOL];
		const runtime = await laneRuntime();

		expect((await laneRequest(runtime))?.type).toBe("error");
		expect(await outerSlotStates()).toEqual({});
	});

	test("(b) once the lane is healthy at +60 s the next request succeeds with no re-login and no restart", async () => {
		laneAccounts = [...MIXED_POOL];
		const runtime = await laneRuntime();
		await laneRequest(runtime);

		clock = NOW + 61_000;
		expect((await laneRequest(runtime))?.type).toBe("done");
	});

	test("an upgrade retires the outer-slot blocks older builds persisted for the lane, with no re-login", async () => {
		// Exactly what older builds left behind: every outer slot blocked as auth_error for the lane's verdict.
		const sidecar = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
		for (const name of ["pinned", "other"]) {
			const credentialRevision = await sidecar.storedCredentialRevision(LANE, name, {
				access: `access-${name}`,
				refresh: `refresh-${name}`,
			});
			await sidecar.mutateSlotState(LANE, "stored", name, () => ({
				blockReason: "auth_error",
				blockedUntil: Date.now() + AUTH_BLOCK_REPROBE_MS,
				failureCount: 3,
				credentialRevision,
			}));
		}
		expect(Object.keys(await outerSlotStates())).toEqual(["pinned", "other"]);
		laneAccounts = [innerAccount("pinned"), innerAccount("other")];
		const runtime = await laneRuntime();

		expect((await laneRequest(runtime))?.type).toBe("done");
		expect(await outerSlotStates()).toEqual({});
	});

	test("a lane account's own 401 is never pinned on an outer slot, so the lane recovers on its own", async () => {
		laneAccounts = [innerAccount("pinned"), innerAccount("other")];
		// What the lane reports when the pinned account's token is rejected and account fallback is off.
		laneAnswer = () =>
			withAuthGuidance(
				new Error("authentication_failed"),
				'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error"}}',
			);
		const runtime = await laneRuntime();
		expect((await laneRequest(runtime))?.type).toBe("error");
		expect(await outerSlotStates()).toEqual({});

		// The token was refreshed outside this process; the same runtime and session must serve again.
		laneAnswer = () => undefined;
		clock = NOW + 60_000;
		expect((await laneRequest(runtime))?.type).toBe("done");
	});
});

describe("a custom provider's unknown or transient error shapes never persist a block (senpi#2081)", () => {
	let dir: string;
	let repository: CredentialSlotRepository;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "custom-2081-"));
		repository = new CredentialSlotRepository(join(dir, "credential-pool-state.json"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const sources = (): RotationSources => ({
		providerId: "custom-gateway",
		credential: {
			type: "api_key",
			key: "key-a",
			accounts: [
				{ name: "a", key: "key-a", source: "login" },
				{ name: "b", key: "key-b", source: "login" },
			],
		} as RotationSources["credential"],
		env: () => undefined,
		repository,
		now: () => NOW,
	});

	test.each([
		[
			"a 520 whose body names an invalid key at the origin",
			errorEvent("520 origin error: invalid api key at upstream", 520),
		],
		[
			"a statusless gateway timeout that mentions unauthorized",
			errorEvent("Gateway timeout: upstream auth service timed out (unauthorized)"),
		],
		[
			"a statusless upstream reset that mentions an authentication error",
			errorEvent("upstream connect error or disconnect/reset before headers; authentication_error"),
		],
		[
			"an unknown, codeless error",
			errorEvent(
				"The provider returned an unexpected error. Action: send the message again; if it repeats, choose another model.",
			),
		],
	] as const)("%s leaves every slot usable for the next request", async (_label, failure) => {
		const run = async (event: AssistantMessageEvent): Promise<AssistantMessageEvent | undefined> => {
			let last: AssistantMessageEvent | undefined;
			const stream = streamWithCredentialRotation({
				sources: sources(),
				affinityKey: "custom-2081",
				runAttempt: async function* () {
					yield event;
				},
			});
			for await (const next of stream) last = next;
			return last;
		};

		expect((await run(failure))?.type).toBe("error");
		expect(await repository.listSlots("custom-gateway", "stored")).toEqual({});
		expect((await run(doneEvent()))?.type).toBe("done");
	});
});
