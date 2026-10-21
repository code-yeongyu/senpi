import type { CustomMessage } from "./messages.ts";
import { STOP_RESUME_CUSTOM_TYPE, stopResumeDirective } from "./stop-resume-directive.ts";

type Message = Pick<CustomMessage, "customType" | "content" | "display" | "details">;
type Part = Extract<CustomMessage["content"], readonly unknown[]>[number];

export interface RunResumePorts {
	readonly heldInputs: () => readonly { readonly inputId: string; readonly text: string }[];
	readonly heldWakes: () => readonly { readonly source: string; readonly message: Message }[];
	readonly send: (message: Message) => Promise<void>;
	readonly turnStarted: () => Promise<string>;
	readonly consume: (inputIds: readonly string[], sources: readonly string[]) => void;
}

function partsOf(content: Message["content"]): Part[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : [...content];
}

/**
 * The child's turn after its parent's run Resume (senpi#3811), as ONE message so it is one turn: held human input
 * first, then the wakes held while paused, then the directive naming the interrupted turn. Answers with the started
 * turn's id once it is running; held input and wakes are consumed once the turn was sent.
 */
export async function startRunResumeTurn(ports: RunResumePorts): Promise<string> {
	const inputs = ports.heldInputs();
	const wakes = ports.heldWakes();
	const content: Part[] = [
		...inputs.map(
			(input): Part => ({ type: "text", text: `The user wrote while the run was paused:\n${input.text}` }),
		),
		...wakes.flatMap((wake) => partsOf(wake.message.content)),
		...partsOf(stopResumeDirective().content),
	];
	const started = ports.turnStarted();
	const sending = ports.send({ customType: STOP_RESUME_CUSTOM_TYPE, content, display: inputs.length > 0 });
	const turnId = await started;
	void sending.then(() =>
		ports.consume(
			inputs.map((input) => input.inputId),
			wakes.map((wake) => wake.source),
		),
	);
	return turnId;
}
