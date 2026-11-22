import type { SealedAnswerReply, SealedLatch } from "./secret-input-requests.ts";
import { parseSealedAnswer } from "./secret-sealed-answers.ts";
import type { SealedHolder, SealedSecretSource } from "./secret-sealed-holders.ts";

/** What one pending or settled request offers a sealed answer: its holder snapshot and its session's latch. */
export interface SealedAnswerTarget {
	readonly sealed: ReadonlySet<SealedHolder>;
	readonly latch: SealedLatch | undefined;
}

/**
 * An `mcp_presenter_secret_answer` from `connection` (D11 secret phase 7.1), for an RPC host and a terminal alike:
 * step 1 the shape, step 2 the sender holds an eligible grant in the request's snapshot, step 3 a settled request
 * answers from its receipt, steps 4 and 5 the authority's checks; the latch then decides (steps 3 and 6 again, at the
 * claim).
 */
export async function answerSealedFrame(
	connection: string,
	value: unknown,
	source: SealedSecretSource | undefined,
	target: (uiRequestId: string) => SealedAnswerTarget | undefined,
): Promise<SealedAnswerReply> {
	const frame = parseSealedAnswer(value);
	if (!frame) return { error: "invalid_secret_response" };
	const found = target(frame.uiRequestId);
	const holder =
		found && source
			? [...found.sealed].find((grant) => grant.id === frame.grantId && source.connectionOf(grant) === connection)
			: undefined;
	const latch = found?.latch;
	if (!source || !holder || !latch || !source.eligible(holder)) return { error: "secret_answer_refused" };
	const principal = source.principalOf(holder);
	const settled = principal === undefined ? undefined : latch.settled(frame.uiRequestId, frame.answerId, principal);
	if (settled) return settled;
	const checked = await source.answer(holder, frame);
	if ("error" in checked || "disposition" in checked) return checked;
	return latch.respond(checked, {
		current: () => source.eligible(holder),
		admitJti: (jti, exp) => source.admitJti(jti, exp),
	});
}
