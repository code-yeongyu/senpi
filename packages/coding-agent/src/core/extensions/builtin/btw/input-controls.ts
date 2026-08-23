import type { AppKeybinding } from "../../../keybindings.ts";

export const BTW_SWITCH_KEYBINDING = "app.btw.switch" as const;
export type BtwSessionCommand = "btw" | "btw-close" | "btw-main";

export interface BtwInputRouter {
	handleInput(data: string): { consume?: boolean; data?: string } | undefined;
}

export function createBtwInputRouter(_input: {
	isCurrentSide: () => boolean;
	isIdle: () => boolean;
	isDialogActive: () => boolean;
	tryBeginBtwCommand: () => boolean;
	tryBeginBtwClose: () => boolean;
	tryBeginBtwMain: () => boolean;
	getBtwInvocationName: (command: BtwSessionCommand) => string | undefined;
	matchesKeybinding: (data: string, binding: AppKeybinding) => boolean;
	dispatch: (command: string) => void;
	now?: () => number;
}): BtwInputRouter {
	const input = _input;
	const now = input.now ?? Date.now;
	let firstIdleInterruptAt: number | undefined;

	function resetInterruptPair(): void {
		firstIdleInterruptAt = undefined;
	}

	return {
		handleInput(data) {
			if (input.matchesKeybinding(data, BTW_SWITCH_KEYBINDING)) {
				resetInterruptPair();
				if (input.isDialogActive()) return undefined;
				const invocationName = input.getBtwInvocationName("btw");
				if (!invocationName) return { consume: true };
				if (!input.tryBeginBtwCommand()) return { consume: true };
				input.dispatch(`/${invocationName}`);
				return { consume: true };
			}
			if (!input.isCurrentSide()) {
				resetInterruptPair();
				return undefined;
			}
			if (input.matchesKeybinding(data, "app.clear")) {
				resetInterruptPair();
				if (input.isDialogActive()) return undefined;
				const invocationName = input.getBtwInvocationName("btw-close");
				if (!invocationName) return { consume: true };
				if (!input.tryBeginBtwClose()) return { consume: true };
				input.dispatch(`/${invocationName}`);
				return { consume: true };
			}
			if (!input.matchesKeybinding(data, "app.interrupt")) {
				resetInterruptPair();
				return undefined;
			}
			if (!input.isIdle()) {
				resetInterruptPair();
				return undefined;
			}
			if (input.isDialogActive()) {
				resetInterruptPair();
				return undefined;
			}
			const pressedAt = now();
			if (
				firstIdleInterruptAt !== undefined &&
				pressedAt >= firstIdleInterruptAt &&
				pressedAt - firstIdleInterruptAt <= 1_000
			) {
				resetInterruptPair();
				const invocationName = input.getBtwInvocationName("btw-main");
				if (!invocationName) return { consume: true };
				if (!input.tryBeginBtwMain()) return { consume: true };
				input.dispatch(`/${invocationName}`);
				return { consume: true };
			}
			firstIdleInterruptAt = pressedAt;
			return undefined;
		},
	};
}
