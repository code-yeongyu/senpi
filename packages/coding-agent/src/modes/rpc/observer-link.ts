/**
 * The supervisor's always-on observer connection to its host's internal socket.
 *
 * The supervisor cannot see turns directly: it proxies the public socket, so it knows the
 * connection count, and it learns about `agent_start` / `agent_settled` only through this one
 * connection. That is why its health is load-bearing for the idle decision - an unhealthy
 * observer means activity is UNKNOWN rather than zero, and the caller reports unknown as busy
 * so that a broken observer can never kill a host mid-turn.
 *
 * Unknown must not be permanent, which is why the link also records WHEN it went unhealthy:
 * the caller can bound how long unknown is allowed to hold a host open.
 */
export interface ObserverSocket {
	/** Close and error both mean the same thing here, so the transport registers one handler. */
	readonly onLost: (handler: () => void) => void;
}

export interface ObserverLinkOptions {
	readonly open: () => Promise<ObserverSocket>;
	/** A supervisor already shutting down or draining has nothing left to observe. */
	readonly settled: () => boolean;
	readonly retryDelayMs: number;
	readonly now: () => number;
	readonly setTimer: (run: () => void, ms: number) => { readonly cancel: () => void };
}

export interface ObserverLink {
	readonly open: () => Promise<void>;
	readonly healthy: () => boolean;
	readonly unhealthySince: () => number | undefined;
	readonly stop: () => void;
}

export interface UnknownActivityInput {
	readonly healthy: boolean;
	readonly unhealthySince: number | undefined;
	readonly now: number;
	readonly unknownGraceMs: number;
	readonly observedBusy: number;
}

/**
 * The turn count the idle decision should see. A healthy observer's count is the truth. An
 * unhealthy one cannot see turns at all, so its count is UNKNOWN and reported as 1 (busy) so a
 * momentary blip never kills a host mid-turn - but only for `graceMs`; past that, unknown has
 * been allowed to hold the host open for a whole idle window and it stops counting as busy.
 */
export function activeTurnsForIdleDecision(input: UnknownActivityInput): number {
	if (input.healthy) return input.observedBusy;
	if (input.unhealthySince === undefined) return 1;
	return input.now - input.unhealthySince < input.unknownGraceMs ? 1 : 0;
}

export function createObserverLink(options: ObserverLinkOptions): ObserverLink {
	let current: ObserverSocket | undefined;
	let healthy = false;
	let unhealthySince: number | undefined;
	let retry: { readonly cancel: () => void } | undefined;

	// Arming is deliberately NOT guarded by socket identity. That guard belongs to `lost`, whose
	// job is to collapse one socket's close AND error into a single transition; reusing it for a
	// failed retry ended the chain, because by then the link owns no socket and the guard is
	// always true. Only settling stops the retries now (#1979).
	const armRetry = (): void => {
		if (retry !== undefined || options.settled()) return;
		retry = options.setTimer(() => {
			retry = undefined;
			void open().catch(armRetry);
		}, options.retryDelayMs);
	};

	async function open(): Promise<void> {
		const socket = await options.open();
		current = socket;
		healthy = true;
		unhealthySince = undefined;
		socket.onLost(() => {
			if (current !== socket || options.settled()) return;
			healthy = false;
			unhealthySince ??= options.now();
			current = undefined;
			armRetry();
		});
	}

	return {
		open,
		healthy: () => healthy,
		unhealthySince: () => unhealthySince,
		stop: () => {
			retry?.cancel();
			retry = undefined;
			current = undefined;
		},
	};
}
