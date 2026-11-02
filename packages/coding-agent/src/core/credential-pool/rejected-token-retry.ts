import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { isCommittedRotationOutput } from "./rotation-events.ts";

type EventSource = AsyncIterable<AssistantMessageEvent> & { result?: () => Promise<AssistantMessage> };

export type RejectableAttempt = {
	stream: EventSource;
	/** The stored OAuth access token this attempt authenticated with, when the provider can refuse it. */
	rejectableAccess?: string;
	/** HTTP statuses that prove `rejectableAccess` was refused (`OAuthAuth.rejectedTokenStatuses`). */
	rejectedTokenStatuses?: readonly number[];
};

// Account-scoped wording: the credential pool reads it as a per-account 403, blocks
// the slot until a new login, and fails over to a healthy sibling account.
const REFUSED_AFTER_REEXCHANGE =
	"A freshly re-exchanged token for this account was refused as well; log in to this account again or switch accounts.";

function refusesToken(event: AssistantMessageEvent, statuses: readonly number[]): boolean {
	if (event.type !== "error" || event.reason !== "error") return false;
	const status = event.error.providerDiagnostic?.httpStatus;
	return status !== undefined && statuses.includes(status);
}

async function* markRefusalAfterReexchange(
	stream: AsyncIterable<AssistantMessageEvent>,
	statuses: readonly number[],
): AsyncGenerator<AssistantMessageEvent> {
	let committed = false;
	for await (const event of stream) {
		if (!committed && event.type === "error" && refusesToken(event, statuses)) {
			// The event and the stream's `result()` share this message, so both carry the note.
			event.error.errorMessage = `${event.error.errorMessage ?? "provider stream error"}\n${REFUSED_AFTER_REEXCHANGE}`;
		}
		committed ||= isCommittedRotationOutput(event);
		yield event;
	}
}

/**
 * Runs one request attempt and, when the provider refuses the stored OAuth token
 * before any output reached the caller, runs it exactly once more with that token
 * named as rejected so auth resolution re-exchanges it. GitHub Copilot revokes its
 * short-lived tokens server-side while they still look valid (#2297); VS Code does
 * the same drop-and-refetch on 401/403. Pre-commit frames are held back so the
 * caller sees one stream, never a start from an attempt that was replaced. A
 * provider that declares no refusal statuses gets its own stream back untouched,
 * and `result()` always follows the attempt that ended the request.
 */
export async function retryOnceOnRejectedToken(
	attempt: (rejectedAccess: string | undefined) => Promise<RejectableAttempt>,
): Promise<EventSource> {
	const first = await attempt(undefined);
	const statuses = first.rejectedTokenStatuses ?? [];
	const rejectedAccess = first.rejectableAccess;
	if (rejectedAccess === undefined || statuses.length === 0) return first.stream;

	let final: EventSource = first.stream;
	async function* events(): AsyncGenerator<AssistantMessageEvent> {
		const iterator = first.stream[Symbol.asyncIterator]();
		const held: AssistantMessageEvent[] = [];
		try {
			while (true) {
				const next = await iterator.next();
				if (next.done) {
					yield* held;
					return;
				}
				const event = next.value;
				if (refusesToken(event, statuses)) {
					await iterator.return?.(undefined);
					const retried = await attempt(rejectedAccess);
					final = retried.stream;
					yield* markRefusalAfterReexchange(retried.stream, statuses);
					return;
				}
				if (isCommittedRotationOutput(event)) {
					yield* held;
					yield event;
					break;
				}
				held.push(event);
			}
			yield* { [Symbol.asyncIterator]: () => iterator };
		} finally {
			await iterator.return?.(undefined);
		}
	}
	const source: EventSource = events();
	if (typeof first.stream.result === "function") {
		source.result = () => final.result?.() ?? Promise.reject(new Error("provider stream has no result"));
	}
	return source;
}
