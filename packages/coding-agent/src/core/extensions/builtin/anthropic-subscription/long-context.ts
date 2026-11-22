import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../../../config.ts";

/** How long a refusal holds before the 1M window is tried again (the account may have enabled extra usage). */
export const LONG_CONTEXT_REFUSAL_TTL_MS = 6 * 60 * 60 * 1_000;

const STATE_FILE = "anthropic-subscription-long-context.json";
/**
 * Refusals before version 2 were recorded for native-1M models too, which never needed the opt-in
 * (senpi#3801); such a record is dropped on first read so the legacy ids do not inherit it.
 */
const STATE_VERSION = 2;

type Listener = (available: boolean) => void;

const listeners = new Set<Listener>();
let refusedUntil: number | undefined;
let loaded = false;
let statePath: () => string = () => join(getAgentDir(), STATE_FILE);

function load(): void {
	if (loaded) return;
	loaded = true;
	try {
		const parsed: unknown = JSON.parse(readFileSync(statePath(), "utf8"));
		const state = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
		if (state.version !== STATE_VERSION) {
			rmSync(statePath(), { force: true });
			return;
		}
		const until = state.refusedUntil;
		if (typeof until === "number" && Number.isFinite(until)) {
			refusedUntil = until;
			scheduleExpiry(Date.now());
		}
	} catch {
		// No state yet, or an unreadable file: the 1M window is assumed available and the next refusal records it.
	}
}

/**
 * Whether the subscription lane may request the 1M window. A refusal ("Extra usage is required for
 * long context") holds for {@link LONG_CONTEXT_REFUSAL_TTL_MS}, across processes, so every session
 * plans against the 200k window it actually gets instead of failing one request each (senpi#3408).
 */
export function longContextAvailable(now = Date.now()): boolean {
	load();
	return refusedUntil === undefined || now >= refusedUntil;
}

let expiryTimer: ReturnType<typeof setTimeout> | undefined;

/** Offers the 1M window again when the refusal expires (the account may have enabled extra usage). */
function scheduleExpiry(now: number): void {
	if (expiryTimer !== undefined) clearTimeout(expiryTimer);
	expiryTimer = undefined;
	if (refusedUntil === undefined || now >= refusedUntil) return;
	expiryTimer = setTimeout(() => {
		expiryTimer = undefined;
		notify(true);
	}, refusedUntil - now);
	expiryTimer.unref?.();
}

function notify(available: boolean): void {
	for (const listener of [...listeners]) {
		try {
			listener(available);
		} catch {
			// One stale listener (a disposed runtime) must not stop the live session's re-registration.
		}
	}
}

export function markLongContextRefused(now = Date.now()): void {
	load();
	const wasAvailable = longContextAvailable(now);
	refusedUntil = now + LONG_CONTEXT_REFUSAL_TTL_MS;
	try {
		mkdirSync(dirname(statePath()), { recursive: true });
		const temporary = `${statePath()}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ version: STATE_VERSION, refusedUntil })}\n`);
		renameSync(temporary, statePath());
	} catch {
		// Persisting only spares the next process one refused request; this process already holds the state.
	}
	scheduleExpiry(now);
	if (wasAvailable) notify(false);
}

export function onLongContextAvailabilityChange(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function _resetLongContextForTesting(path?: string): void {
	if (expiryTimer !== undefined) clearTimeout(expiryTimer);
	expiryTimer = undefined;
	refusedUntil = undefined;
	loaded = false;
	listeners.clear();
	statePath = path === undefined ? () => join(getAgentDir(), STATE_FILE) : () => path;
}
