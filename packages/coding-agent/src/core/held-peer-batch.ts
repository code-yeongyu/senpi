import { isSessionControlDeliveryDetails, SESSION_CONTROL_DELIVERY_TYPE } from "./extensions/session-control-types.ts";
import type { CustomMessage } from "./messages.ts";
import { copyInputTurnMark, sameInputTurnMark } from "./turn-origin.ts";

export interface HeldRelease {
	readonly source: string;
	readonly noticeIds: readonly string[];
	readonly message: CustomMessage;
}

type Part = Extract<CustomMessage["content"], readonly unknown[]>[number];

/** Who a held peer delivery speaks for: two deliveries share a turn only when this and their origin mark agree. */
function speaker(message: CustomMessage): string | undefined {
	if (message.customType !== SESSION_CONTROL_DELIVERY_TYPE || !isSessionControlDeliveryDetails(message.details))
		return undefined;
	const { sender, remote_origin, deliverAs } = message.details;
	return JSON.stringify({ sender, remote_origin, deliverAs });
}

function partsOf(content: CustomMessage["content"]): Part[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

function fold(run: readonly HeldRelease[]): HeldRelease {
	const [first, ...rest] = run;
	if (first === undefined) throw new Error("an empty run of held deliveries");
	if (rest.length === 0) return first;
	if (!isSessionControlDeliveryDetails(first.message.details))
		throw new Error("a folded run holds a non-peer message");
	// The first delivery's entry records the turn; every delivery's id stays proven by its own held notice.
	const { display_text: _display, ...details } = first.message.details;
	const message: CustomMessage = {
		...first.message,
		content: run.flatMap((release) => partsOf(release.message.content)),
		details,
	};
	copyInputTurnMark(first.message, message);
	return { source: first.source, noticeIds: run.flatMap((release) => release.noticeIds), message };
}

/**
 * Held releases in delivery order, with each run of peer deliveries from one speaker under one origin mark folded into
 * one message, so an unattended resume opens one turn for them instead of one per delivery (senpi#7588). Deliveries
 * from another speaker or origin keep their own turn: one turn has one origin.
 */
export function batchHeldReleases(releases: readonly HeldRelease[]): HeldRelease[] {
	const batched: HeldRelease[] = [];
	let run: HeldRelease[] = [];
	for (const release of releases) {
		const last = run.at(-1);
		const key = speaker(release.message);
		const joins =
			last !== undefined &&
			key !== undefined &&
			key === speaker(last.message) &&
			sameInputTurnMark(last.message, release.message);
		if (!joins && run.length > 0) {
			batched.push(fold(run));
			run = [];
		}
		if (key === undefined) batched.push(release);
		else run.push(release);
	}
	if (run.length > 0) batched.push(fold(run));
	return batched;
}
