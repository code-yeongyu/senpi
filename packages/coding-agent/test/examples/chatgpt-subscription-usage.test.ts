import { Buffer } from "node:buffer";
import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	type CodexUsage,
	codexUsageStatusText,
	fetchCodexUsage,
	formatCodexUsage,
	parseCodexUsage,
	startCodexUsagePolling,
} from "../../examples/extensions/chatgpt-subscription-usage/codex-usage.ts";
import codexUsageExtension, {
	shouldLoadCodexUsage,
} from "../../examples/extensions/chatgpt-subscription-usage/index.ts";

type CommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
type EventHandler = (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown;
type LifecycleEventName = "session_start" | "model_select" | "session_shutdown";

type Deferred<T> = ReturnType<typeof Promise.withResolvers<T>>;

const STATUS_KEY = "provider-usage";
const UNAVAILABLE_STATUS = "Codex usage unavailable";
const TEST_ACCOUNT_ID = "test-account";
const TEST_ACCESS_TOKEN = `header.${Buffer.from(
	JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: TEST_ACCOUNT_ID } }),
).toString("base64url")}.signature`;

function createModel(id: string, provider = "chatgpt-subscription"): NonNullable<ExtensionContext["model"]> {
	return { id, provider } as NonNullable<ExtensionContext["model"]>;
}

function usageResponse(): Response {
	return Response.json({
		rate_limit: {
			primary_window: {
				used_percent: 12,
				limit_window_seconds: 18_000,
			},
			secondary_window: {
				used_percent: 34,
				limit_window_seconds: 604_800,
			},
		},
	});
}

function createExtensionHarness() {
	const commands = new Map<string, CommandHandler>();
	const handlers = new Map<string, EventHandler>();
	const statusHistory: Array<{ key: string; text: string | undefined }> = [];
	const statusWaiters = new Set<{
		key: string;
		text: string | undefined;
		resolve: () => void;
	}>();
	const setStatus = vi.fn((key: string, text: string | undefined) => {
		statusHistory.push({ key, text });
		for (const waiter of [...statusWaiters]) {
			if (waiter.key !== key || waiter.text !== text) continue;
			statusWaiters.delete(waiter);
			waiter.resolve();
		}
	});
	const notify = vi.fn();
	const isUsingOAuth = vi.fn(
		(model: Parameters<ExtensionContext["modelRegistry"]["isUsingOAuth"]>[0]) =>
			model.provider === "chatgpt-subscription",
	);
	const getApiKeyAndHeaders = vi.fn<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>(async () => ({
		ok: true,
		apiKey: TEST_ACCESS_TOKEN,
	}));
	const context = {
		hasUI: true,
		model: createModel("codex-1"),
		modelRegistry: {
			isUsingOAuth,
			getApiKeyAndHeaders,
		},
		ui: {
			setStatus,
			notify,
			theme: {
				fg: (_color: string, text: string) => text,
			},
		},
	} as unknown as ExtensionContext;
	const api = {
		registerCommand(name: string, definition: { handler: CommandHandler }) {
			commands.set(name, definition.handler);
		},
		on(eventName: string, handler: unknown) {
			handlers.set(eventName, handler as EventHandler);
		},
	} as unknown as ExtensionAPI;

	codexUsageExtension(api);

	return {
		context,
		getApiKeyAndHeaders,
		notify,
		setStatus,
		statusHistory,
		waitForStatus(key: string, text: string | undefined): Promise<void> {
			const deferred = Promise.withResolvers<void>();
			statusWaiters.add({ key, text, resolve: deferred.resolve });
			return deferred.promise;
		},
		async emit(eventName: LifecycleEventName): Promise<void> {
			const handler = handlers.get(eventName);
			if (!handler) throw new Error(`Missing ${eventName} handler`);
			const event =
				eventName === "session_start"
					? { type: eventName, reason: "startup" }
					: eventName === "session_shutdown"
						? { type: eventName, reason: "quit" }
						: { type: eventName };
			await handler(event, context);
		},
		async runUsageCommand(): Promise<void> {
			const handler = commands.get("usage");
			if (!handler) throw new Error("Missing usage command");
			await handler("", context);
		},
	};
}

function pendingFetch(started: Deferred<AbortSignal>, aborted: Deferred<void>): typeof fetch {
	return async (_input, init) => {
		const signal = init?.signal;
		if (!(signal instanceof AbortSignal)) throw new Error("Expected an AbortSignal");
		started.resolve(signal);
		return await new Promise<Response>((_resolve, reject) => {
			const onAbort = () => {
				aborted.resolve();
				reject(signal.reason);
			};
			if (signal.aborted) {
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		});
	};
}

const refreshFailures: Array<[string, () => Promise<Response>]> = [
	["network or redirect rejection", async () => Promise.reject(new TypeError("fetch failed"))],
	["timeout", async () => Promise.reject(new DOMException("timed out", "TimeoutError"))],
	["invalid JSON", async () => new Response("{", { status: 200 })],
];

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("shouldLoadCodexUsage", () => {
	it("requires UI, the Codex provider, and OAuth", () => {
		expect(shouldLoadCodexUsage("chatgpt-subscription", true, true)).toBe(true);
		expect(shouldLoadCodexUsage("chatgpt-subscription", false, true)).toBe(false);
		expect(shouldLoadCodexUsage("chatgpt-subscription", true, false)).toBe(false);
		expect(shouldLoadCodexUsage("anthropic", true, true)).toBe(false);
	});
});

describe("parseCodexUsage", () => {
	it("selects limits by window duration when slots are reversed", () => {
		const usage = parseCodexUsage({
			rate_limit: {
				primary_window: {
					used_percent: 25,
					limit_window_seconds: 604_800,
				},
				secondary_window: {
					used_percent: 40,
					limit_window_seconds: 18_000,
				},
			},
		});

		expect(usage).toEqual({
			fiveHourRemainingPercent: 60,
			weeklyRemainingPercent: 75,
		});
	});

	it("preserves an absent five-hour cap as unavailable", () => {
		const usage = parseCodexUsage({
			rate_limit: {
				primary_window: null,
				secondary_window: {
					used_percent: 9,
					limit_window_seconds: 604_800,
				},
			},
		});

		expect(usage).toEqual({
			fiveHourRemainingPercent: undefined,
			weeklyRemainingPercent: 91,
		});
		expect(usage && formatCodexUsage(usage)).toBe("5h unavailable | W 91%");
	});

	it("renders unavailable when the rate-limit object has no recognized window", () => {
		const usage = parseCodexUsage({
			rate_limit: {
				primary_window: {
					used_percent: 25,
					limit_window_seconds: 3_600,
				},
			},
		});

		expect(usage).toEqual({
			fiveHourRemainingPercent: undefined,
			weeklyRemainingPercent: undefined,
		});
		expect(usage && formatCodexUsage(usage)).toBe("5h unavailable | W unavailable");
	});

	it("rejects a response without a rate-limit object", () => {
		expect(parseCodexUsage({ plan_type: "plus" })).toBeNull();
	});
});

describe("formatCodexUsage", () => {
	it("renders compact five-hour and weekly labels", () => {
		const rendered = formatCodexUsage({
			fiveHourRemainingPercent: 83,
			weeklyRemainingPercent: 57,
		});

		expect(rendered).toBe("5h 83% | W 57%");
	});
});

describe("codexUsageStatusText", () => {
	it("renders Codex limits when visibility is enabled", () => {
		const rendered = codexUsageStatusText(
			"chatgpt-subscription",
			{
				fiveHourRemainingPercent: 88,
				weeklyRemainingPercent: 66,
			},
			true,
		);

		expect(rendered).toBe("5h 88% | W 66%");
	});

	it("hides limits when visibility is disabled", () => {
		const rendered = codexUsageStatusText(
			"chatgpt-subscription",
			{
				fiveHourRemainingPercent: 88,
				weeklyRemainingPercent: 66,
			},
			false,
		);

		expect(rendered).toBeUndefined();
	});

	it("hides limits for another provider", () => {
		const rendered = codexUsageStatusText(
			"anthropic",
			{
				fiveHourRemainingPercent: 88,
				weeklyRemainingPercent: 66,
			},
			true,
		);

		expect(rendered).toBeUndefined();
	});
});

describe("fetchCodexUsage", () => {
	it("uses resolved Senpi OAuth credentials", async () => {
		let requestedUrl = "";
		let requestedHeaders: Headers | undefined;
		let requestedRedirect: "error" | undefined;

		const usage = await fetchCodexUsage({
			credentials: {
				accessToken: "test-access",
				accountId: TEST_ACCOUNT_ID,
			},
			request: async (input, init) => {
				requestedUrl = input;
				requestedHeaders = new Headers(init.headers);
				requestedRedirect = init.redirect;
				return usageResponse();
			},
		});

		expect({
			usage,
			requestedUrl,
			authorization: requestedHeaders?.get("Authorization"),
			accountId: requestedHeaders?.get("ChatGPT-Account-Id"),
			redirect: requestedRedirect,
		}).toEqual({
			usage: {
				fiveHourRemainingPercent: 88,
				weeklyRemainingPercent: 66,
			},
			requestedUrl: "https://chatgpt.com/backend-api/wham/usage",
			authorization: "Bearer test-access",
			accountId: TEST_ACCOUNT_ID,
			redirect: "error",
		});
	});

	it.each([401, 429, 500])("rejects HTTP %i without reading the response body", async (status) => {
		const json = vi.fn(async () => ({ error: "sensitive body" }));

		await expect(
			fetchCodexUsage({
				credentials: {
					accessToken: "test-access",
					accountId: TEST_ACCOUNT_ID,
				},
				request: async () => ({ ok: false, status, json }),
			}),
		).rejects.toThrow(`Codex usage endpoint returned HTTP ${status}`);
		expect(json).not.toHaveBeenCalled();
	});

	it("forwards cancellation into the HTTP request", async () => {
		const controller = new AbortController();
		const requestStarted = Promise.withResolvers<void>();
		let requestSignal: AbortSignal | undefined;
		const request = fetchCodexUsage({
			credentials: {
				accessToken: "test-access",
				accountId: TEST_ACCOUNT_ID,
			},
			signal: controller.signal,
			request: async (_input, init) => {
				requestSignal = init.signal;
				requestStarted.resolve();
				await new Promise<never>((_resolve, reject) => {
					init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
				});
				return Response.json({});
			},
		});

		await requestStarted.promise;
		controller.abort();

		await expect(request).rejects.toBeDefined();
		expect(requestSignal?.aborted).toBe(true);
	});
});

describe("startCodexUsagePolling", () => {
	it("publishes initial usage without waiting for an interval", async () => {
		const expected = {
			fiveHourRemainingPercent: 88,
			weeklyRemainingPercent: 66,
		};
		const observed = Promise.withResolvers<CodexUsage | null>();
		const timeout = AbortSignal.timeout(1_000);
		const timedOut = new Promise<never>((_resolve, reject) => {
			timeout.addEventListener("abort", () => reject(new Error("usage polling did not publish")), { once: true });
		});

		const polling = startCodexUsagePolling({
			active: () => true,
			load: async () => expected,
			onUsage: observed.resolve,
			onError: observed.reject,
		});

		try {
			expect(await Promise.race([observed.promise, timedOut])).toEqual(expected);
		} finally {
			polling.stop();
		}
	});

	it("aborts an in-flight load without reporting an error after stop", async () => {
		const started = Promise.withResolvers<AbortSignal>();
		const finished = Promise.withResolvers<void>();
		const errors: unknown[] = [];
		const usages: unknown[] = [];
		const polling = startCodexUsagePolling({
			active: () => true,
			load: async (signal) => {
				started.resolve(signal);
				try {
					await new Promise<never>((_resolve, reject) => {
						signal.addEventListener("abort", () => reject(signal.reason), {
							once: true,
						});
					});
				} finally {
					finished.resolve();
				}
				return null;
			},
			onUsage: (usage) => usages.push(usage),
			onError: (error) => errors.push(error),
		});

		const signal = await started.promise;
		polling.stop();
		await finished.promise;

		expect(signal.aborted).toBe(true);
		expect(errors).toEqual([]);
		expect(usages).toEqual([]);
	});

	it("does not overlap scheduled refreshes and clears the interval on stop", async () => {
		vi.useFakeTimers();
		const expected = {
			fiveHourRemainingPercent: 88,
			weeklyRemainingPercent: 66,
		};
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const observed = Promise.withResolvers<CodexUsage | null>();
		let loadCalls = 0;
		const polling = startCodexUsagePolling({
			active: () => true,
			load: async () => {
				loadCalls += 1;
				started.resolve();
				await release.promise;
				return expected;
			},
			onUsage: observed.resolve,
			onError: observed.reject,
		});

		try {
			await started.promise;
			await vi.advanceTimersByTimeAsync(60_000);
			expect(loadCalls).toBe(1);

			release.resolve();
			expect(await observed.promise).toEqual(expected);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(loadCalls).toBe(2);

			polling.stop();
			await vi.advanceTimersByTimeAsync(180_000);
			expect(loadCalls).toBe(2);
		} finally {
			polling.stop();
		}
	});
});

describe("chatgpt-subscription-usage extension lifecycle", () => {
	it.each(refreshFailures)("replaces prior usage with unavailable after %s", async (_label, failRefresh) => {
		vi.useFakeTimers();
		const fetchMock = vi.fn<typeof fetch>();
		fetchMock.mockResolvedValueOnce(usageResponse()).mockImplementationOnce(failRefresh);
		vi.stubGlobal("fetch", fetchMock);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const harness = createExtensionHarness();

		try {
			const published = harness.waitForStatus(STATUS_KEY, "5h 88% | W 66%");
			await harness.emit("session_start");
			await published;

			const unavailable = harness.waitForStatus(STATUS_KEY, UNAVAILABLE_STATUS);
			await vi.advanceTimersByTimeAsync(60_000);
			await unavailable;

			expect(harness.statusHistory.at(-1)).toEqual({ key: STATUS_KEY, text: UNAVAILABLE_STATUS });
			expect(consoleError).toHaveBeenCalledWith("[chatgpt-subscription-usage] Refresh failed");
		} finally {
			await harness.emit("session_shutdown");
		}
	});

	it("toggles polling and publication through /usage", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => usageResponse());
		vi.stubGlobal("fetch", fetchMock);
		const harness = createExtensionHarness();

		try {
			const initiallyPublished = harness.waitForStatus(STATUS_KEY, "5h 88% | W 66%");
			await harness.emit("session_start");
			await initiallyPublished;
			expect(harness.getApiKeyAndHeaders).toHaveBeenCalledTimes(1);

			const cleared = harness.waitForStatus(STATUS_KEY, undefined);
			await harness.runUsageCommand();
			await cleared;
			expect(harness.notify).toHaveBeenLastCalledWith("Provider usage: hidden", "info");
			const callsWhileHidden = fetchMock.mock.calls.length;
			await vi.advanceTimersByTimeAsync(180_000);
			expect(fetchMock).toHaveBeenCalledTimes(callsWhileHidden);

			const republished = harness.waitForStatus(STATUS_KEY, "5h 88% | W 66%");
			await harness.runUsageCommand();
			await republished;
			expect(harness.notify).toHaveBeenLastCalledWith("Provider usage: shown", "info");
			expect(fetchMock).toHaveBeenCalledTimes(callsWhileHidden + 1);
		} finally {
			await harness.emit("session_shutdown");
		}
	});

	it("aborts and restarts on model change, then clears the timer on shutdown", async () => {
		vi.useFakeTimers();
		const firstStarted = Promise.withResolvers<AbortSignal>();
		const firstAborted = Promise.withResolvers<void>();
		const secondStarted = Promise.withResolvers<AbortSignal>();
		const secondAborted = Promise.withResolvers<void>();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockImplementationOnce(pendingFetch(firstStarted, firstAborted))
			.mockImplementationOnce(pendingFetch(secondStarted, secondAborted));
		vi.stubGlobal("fetch", fetchMock);
		const harness = createExtensionHarness();

		try {
			await harness.emit("session_start");
			const firstSignal = await firstStarted.promise;

			harness.context.model = createModel("codex-2");
			const clearedForModel = harness.waitForStatus(STATUS_KEY, undefined);
			await harness.emit("model_select");
			await clearedForModel;
			const secondSignal = await secondStarted.promise;
			await firstAborted.promise;

			expect(firstSignal.aborted).toBe(true);
			expect(secondSignal.aborted).toBe(false);
			expect(fetchMock).toHaveBeenCalledTimes(2);

			const clearedForShutdown = harness.waitForStatus(STATUS_KEY, undefined);
			await harness.emit("session_shutdown");
			await clearedForShutdown;
			await secondAborted.promise;
			expect(secondSignal.aborted).toBe(true);

			await vi.advanceTimersByTimeAsync(180_000);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		} finally {
			await harness.emit("session_shutdown");
		}
	});
});
