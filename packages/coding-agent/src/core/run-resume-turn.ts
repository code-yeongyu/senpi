import type { ImageContent } from "@earendil-works/pi-ai";
import type { CustomMessage } from "./messages.ts";
import { stopResumeDirective } from "./stop-resume-directive.ts";

type Message = Pick<CustomMessage, "customType" | "content" | "display" | "details">;
type Part = Extract<CustomMessage["content"], readonly unknown[]>[number];

export interface RunResumePorts {
	readonly resumeCause?: "stop" | "interrupted";
	readonly heldInputs: () => readonly {
		readonly inputId: string;
		readonly text: string;
		readonly images?: readonly ImageContent[];
	}[];
	/** Held manual-continue inputs: the turn continues the work itself, so it consumes them without carrying them. */
	readonly continueInputs: () => readonly string[];
	readonly heldWakes: () => readonly { readonly source: string; readonly message: Message }[];
	readonly send: (message: Message) => Promise<void>;
	/** The next turn's id once it starts, or undefined once `until` settles first; it stops listening either way. */
	readonly turnStarted: (until: Promise<void>) => Promise<string | undefined>;
	readonly idle: () => Promise<void>;
	/** False once a Stop newer than the one this resume released has landed. */
	readonly current: () => boolean;
	readonly consume: (inputIds: readonly string[], sources: readonly string[]) => void;
	readonly sendFailed: (error: unknown) => void;
}

function partsOf(content: Message["content"]): Part[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

/**
 * The turn after a Stop or a parent's run Resume (senpi#3811), as ONE message so it is one turn: held human input
 * first, then the wakes held while paused, then the directive naming the interrupted turn. Answers once that turn
 * started, or once the send settled without starting one (a newer Stop during admission), so a resume never waits on
 * a turn that will not come. `delivered` is the one settlement rule both resume paths share: it hands the held input
 * and wakes to `consume` only if the turn started, its send succeeded, and no newer Stop aborted it.
 */
export async function startRunResumeTurn(
	ports: RunResumePorts,
): Promise<{ turnId: string | undefined; delivered: Promise<boolean> }> {
	const inputs = ports.heldInputs();
	const continues = ports.continueInputs();
	const wakes = ports.heldWakes();
	const directive = stopResumeDirective(ports.resumeCause);
	const content: Part[] = [
		...inputs.flatMap((input): Part[] => [
			{ type: "text", text: `The user wrote while the run was paused:\n${input.text}` },
			...(input.images ?? []),
		]),
		...wakes.flatMap((wake) => partsOf(wake.message.content)),
		...partsOf(directive.content),
	];
	const sendSettled = Promise.withResolvers<void>();
	const started = ports.turnStarted(sendSettled.promise);
	const sending = ports.send({ ...directive, content, display: inputs.length > 0 });
	sending.then(sendSettled.resolve, sendSettled.resolve);
	const turnId = await started;
	const delivered = (async () => {
		await ports.idle();
		try {
			await sending;
		} catch (error) {
			ports.sendFailed(error);
			return false;
		}
		if (turnId === undefined || !ports.current()) return false;
		ports.consume(
			[...inputs.map((input) => input.inputId), ...continues],
			wakes.map((wake) => wake.source),
		);
		return true;
	})();
	return { turnId, delivered };
}
