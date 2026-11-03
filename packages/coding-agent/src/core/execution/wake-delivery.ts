import type { WakeEvent, WakeOutbox, WakeReceipt } from "@earendil-works/pi-agent-core/conformance";
import type { TerminalNotifierDeps } from "../extensions/builtin/terminal/notify.ts";

export const TERMINAL_WAKE_SOURCE = "terminal";

type SendMessage = TerminalNotifierDeps["sendMessage"];

export function terminalWakeSender(_options: {
	readonly outbox: WakeOutbox;
	readonly scope: string;
	readonly send: (wake: WakeEvent) => Promise<WakeReceipt>;
	readonly onError: (error: unknown) => void;
}): SendMessage {
	return () => {};
}

export function deliverTerminalWake(_wake: WakeEvent, _sendMessage: SendMessage): void {}
