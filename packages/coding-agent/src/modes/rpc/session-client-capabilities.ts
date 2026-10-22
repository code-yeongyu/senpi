import { EXTENSION_EVENTS_CAPABILITY, QUESTION_CAPABILITY } from "./custom-capability.ts";

/**
 * The client capabilities one session handler answers with. On a shared host they are the union of the
 * attached connections' declarations, set by the router (omo-desktop-app#4042); a single-connection process
 * starts with its launch capabilities and replaces them on a declaration. Changing them re-subscribes extension events when `extension_events` comes
 * or goes, and withdrawing `question` cancels the structured questions no attached connection can answer.
 */
export class SessionClientCapabilities {
	private value: readonly string[] | undefined;
	private readonly onExtensionEventsChanged: () => void;
	private readonly onQuestionWithdrawn: () => void;

	constructor(
		initial: readonly string[] | undefined,
		effects: { readonly extensionEventsChanged: () => void; readonly questionWithdrawn: () => void },
	) {
		this.value = initial;
		this.onExtensionEventsChanged = effects.extensionEventsChanged;
		this.onQuestionWithdrawn = effects.questionWithdrawn;
	}

	current(): readonly string[] | undefined {
		return this.value;
	}

	has(capability: string): boolean {
		return this.value?.includes(capability) ?? false;
	}

	replace(next: readonly string[]): void {
		const hadEvents = this.has(EXTENSION_EVENTS_CAPABILITY);
		const hadQuestion = this.has(QUESTION_CAPABILITY);
		this.value = [...next];
		if (hadQuestion && !this.has(QUESTION_CAPABILITY)) this.onQuestionWithdrawn();
		if (hadEvents !== this.has(EXTENSION_EVENTS_CAPABILITY)) this.onExtensionEventsChanged();
	}
}
