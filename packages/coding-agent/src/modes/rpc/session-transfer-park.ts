/**
 * A retained session's park as a strict transfer (code-yeongyu/oh-my-openagent#10091). The session is sealed in
 * the step that judged it quiet, its transfer intent (the park record its next owner reopens it from) is written
 * durably, and only then, after one more quiet check in the same synchronous step as the teardown claim, is it
 * torn down. A record that cannot be written leaves the session open, unsealed and owned here, and the park is
 * tried again after a backoff: a retained session is never torn down without the record that brings it back.
 */
import { parkedEntryFromProfile } from "./host-handover-parked-open.ts";
import { clearHandoverParkedSession, recordHandoverParkedSession } from "./host-handover-parked.ts";
import { hostInstanceId } from "./protocol-identity.ts";
import type { RpcSessionEntry } from "./session-registry-types.ts";
import type { RouterContext } from "./session-router-context.ts";
import { entryTransferBlockers } from "./session-transfer-quiescence.ts";
import { sealTransfer, type TransferSeal, unsealTransfer } from "./session-transfer-seal.ts";

const PARK_RETRY_FIRST_MS = 250;
const PARK_RETRY_MAX_MS = 30_000;

export interface ParkIntent {
	readonly seal: TransferSeal;
	readonly dir: string;
	readonly sessionPath: string;
}

export function parkDue(host: RouterContext, sessionId: string): boolean {
	const retry = host.parkRetryAt.get(sessionId);
	return retry === undefined || host.idleNow() >= retry.at;
}

/**
 * Seals `sessionId` and writes its park record. `undefined` when the session must stay: a transfer of it is
 * already in flight, or the record could not be written (the session is unsealed and the park deferred).
 */
export async function writeParkIntent(
	host: RouterContext,
	sessionId: string,
	retained: RpcSessionEntry,
	sessionPath: string,
	dir: string,
): Promise<ParkIntent | undefined> {
	const seal = sealTransfer(host, sessionId);
	if (seal === undefined) return undefined;
	try {
		await recordHandoverParkedSession(dir, {
			...parkedEntryFromProfile(
				{
					sessionPath,
					contextOverlay: retained.contextOverlay,
					...(retained.durableSessionId !== undefined ? { durableSessionId: retained.durableSessionId } : {}),
				},
				retained.profile,
				Object.keys(host.defaults.hostContext ?? {}),
			),
			parkedBy: host.defaults.hostContext?.host_instance ?? hostInstanceId(),
			transferId: seal.transferId,
		});
	} catch (cause) {
		unsealTransfer(host, sessionId, seal, true);
		deferPark(host, sessionId, cause);
		return undefined;
	}
	host.parkRetryAt.delete(sessionId);
	return { seal, dir, sessionPath };
}

/** The final quiet check, made in the same synchronous step as the caller's teardown claim. */
export function stillQuiet(host: RouterContext, sessionId: string): boolean {
	const entry = host.registry.peek(sessionId);
	if (entry === undefined || entry.state !== "open") return false;
	const requests = host.activeRequests.get(sessionId) ?? 0;
	const prompts = () => host.bindings.get(sessionId)?.pendingPrompts?.().length ?? 0;
	return entryTransferBlockers(entry, prompts, requests).length === 0;
}

/** Takes the transfer back: its record is removed and the session admits work here again unless `ended`. */
export async function withdrawParkIntent(
	host: RouterContext,
	sessionId: string,
	intent: ParkIntent,
	ended: boolean,
): Promise<void> {
	unsealTransfer(host, sessionId, intent.seal, !ended);
	await clearHandoverParkedSession(intent.dir, intent.sessionPath, intent.seal.transferId).catch((cause: unknown) => {
		process.stderr.write(`senpi rpc handover park record ${sessionId} could not be withdrawn: ${String(cause)}\n`);
	});
}

function deferPark(host: RouterContext, sessionId: string, cause: unknown): void {
	const attempts = (host.parkRetryAt.get(sessionId)?.attempts ?? 0) + 1;
	const delay = Math.min(PARK_RETRY_MAX_MS, PARK_RETRY_FIRST_MS * 2 ** (attempts - 1));
	host.parkRetryAt.set(sessionId, { at: host.idleNow() + delay, attempts });
	process.stderr.write(
		`senpi rpc handover park record ${sessionId} could not be written; the session stays here (attempt ${attempts}, next in ${delay} ms): ${String(cause)}\n`,
	);
}
