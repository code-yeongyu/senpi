const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;
const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 10_000;

export interface CodexUsage {
	readonly fiveHourRemainingPercent: number | undefined;
	readonly weeklyRemainingPercent: number | undefined;
}

interface UsageResponse {
	readonly ok: boolean;
	readonly status: number;
	json(): Promise<unknown>;
}

interface UsageRequestInit {
	readonly headers: Readonly<Record<string, string>>;
	readonly redirect: "error";
	readonly signal: AbortSignal;
}

export interface CodexUsageRequestOptions {
	readonly credentials: {
		readonly accessToken: string;
		readonly accountId: string | undefined;
	};
	readonly request?: (input: string, init: UsageRequestInit) => Promise<UsageResponse>;
	readonly signal?: AbortSignal;
}

export interface CodexUsagePollingOptions {
	readonly active: () => boolean;
	readonly load: (signal: AbortSignal) => Promise<CodexUsage | null>;
	readonly onUsage: (usage: CodexUsage | null) => void;
	readonly onError: (error: unknown) => void;
}

export interface CodexUsagePollingController {
	refresh(): Promise<void>;
	stop(): void;
}

function property(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function remainingPercent(value: unknown): number | undefined {
	const usedPercent = property(value, "used_percent");
	return typeof usedPercent === "number" && Number.isFinite(usedPercent)
		? Math.round(100 - Math.max(0, Math.min(100, usedPercent)))
		: undefined;
}

export function parseCodexUsage(value: unknown): CodexUsage | null {
	const rateLimit = property(value, "rate_limit");
	const windows = [property(rateLimit, "primary_window"), property(rateLimit, "secondary_window")];
	let fiveHourRemainingPercent: number | undefined;
	let weeklyRemainingPercent: number | undefined;

	for (const window of windows) {
		const duration = property(window, "limit_window_seconds");
		const remaining = remainingPercent(window);
		if (remaining === undefined) continue;
		if (duration === FIVE_HOURS_SECONDS) {
			fiveHourRemainingPercent = remaining;
		}
		if (duration === WEEK_SECONDS) {
			weeklyRemainingPercent = remaining;
		}
	}

	if (typeof rateLimit !== "object" || rateLimit === null) {
		return null;
	}

	return {
		fiveHourRemainingPercent,
		weeklyRemainingPercent,
	};
}

function formatRemainingPercent(value: number | undefined): string {
	return value === undefined ? "unavailable" : `${value}%`;
}

export function formatCodexUsage(usage: CodexUsage): string {
	return `5h ${formatRemainingPercent(usage.fiveHourRemainingPercent)} | W ${formatRemainingPercent(usage.weeklyRemainingPercent)}`;
}

export function codexUsageStatusText(
	provider: string | undefined,
	usage: CodexUsage | null,
	visible: boolean,
): string | undefined {
	return visible && provider === "chatgpt-subscription" && usage ? formatCodexUsage(usage) : undefined;
}

export async function fetchCodexUsage(options: CodexUsageRequestOptions): Promise<CodexUsage | null> {
	const request = options.request ?? ((input: string, init: UsageRequestInit) => fetch(input, init));
	const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
	const response = await request(USAGE_ENDPOINT, {
		headers: {
			Authorization: `Bearer ${options.credentials.accessToken}`,
			...(options.credentials.accountId ? { "ChatGPT-Account-Id": options.credentials.accountId } : {}),
		},
		redirect: "error",
		signal,
	});
	if (!response.ok) {
		throw new Error(`Codex usage endpoint returned HTTP ${response.status}`);
	}
	return parseCodexUsage(await response.json());
}

export function startCodexUsagePolling(options: CodexUsagePollingOptions): CodexUsagePollingController {
	let errorReported = false;
	let refreshing = false;
	let stopped = false;
	let activeController: AbortController | undefined;
	const refresh = async (): Promise<void> => {
		if (stopped || refreshing) return;
		if (!options.active()) {
			options.onUsage(null);
			return;
		}
		refreshing = true;
		const controller = new AbortController();
		activeController = controller;
		try {
			const usage = await options.load(controller.signal);
			if (stopped || controller.signal.aborted) return;
			options.onUsage(usage);
			errorReported = false;
		} catch (error) {
			if (!stopped && !controller.signal.aborted && !errorReported) {
				options.onError(error);
				errorReported = true;
			}
		} finally {
			if (activeController === controller) {
				activeController = undefined;
			}
			refreshing = false;
		}
	};
	void refresh();
	const timer = setInterval(() => void refresh(), 60_000);
	return {
		refresh,
		stop: () => {
			stopped = true;
			activeController?.abort();
			activeController = undefined;
			clearInterval(timer);
		},
	};
}
