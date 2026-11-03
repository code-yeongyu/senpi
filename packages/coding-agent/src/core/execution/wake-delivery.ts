import type { StoreValue, WakeEvent, WakeOutbox, WakeReceipt } from "@earendil-works/pi-agent-core/conformance";
import type { TerminalNotifierDeps } from "../extensions/builtin/terminal/notify.ts";
import { toStoreValue } from "./executor-freeze.ts";

const TERMINAL_WAKE_SOURCE = "terminal";

type SendMessage = TerminalNotifierDeps["sendMessage"];
type Message = Parameters<SendMessage>[0];
type Options = Parameters<SendMessage>[1];

/**
 * The terminal notifier's `sendMessage` on a hand (design 5.6.4): the notification is committed to the hand's durable
 * outbox, then every un-acked wake is offered to the brain. A failure leaves the wake in the outbox for the next
 * re-offer and is reported to `onError`; a fused session never uses this and keeps calling its own `sendMessage`.
 */
export function terminalWakeSender(options: {
	readonly outbox: WakeOutbox;
	readonly scope: string;
	readonly send: (wake: WakeEvent) => Promise<WakeReceipt>;
	readonly onError: (error: unknown) => void;
}): SendMessage {
	const { outbox, scope, send, onError } = options;
	return (message, delivery) => {
		const payload: StoreValue = toStoreValue({ message, options: delivery });
		void outbox
			.offer({ scope, source: TERMINAL_WAKE_SOURCE, payload })
			.then(() => outbox.reoffer(send))
			.catch(onError);
	};
}

type StoreObject = { readonly [key: string]: StoreValue };

const object = (value: StoreValue | undefined): value is StoreObject =>
	value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value);

function terminalPayload(payload: StoreValue): { readonly message: Message; readonly options: Options } {
	if (!object(payload)) throw new Error("malformed wake");
	const { message, options } = payload;
	if (
		!object(message) ||
		typeof message.customType !== "string" ||
		typeof message.content !== "string" ||
		typeof message.display !== "boolean" ||
		!object(options) ||
		typeof options.triggerTurn !== "boolean" ||
		(options.deliverAs !== "steer" && options.deliverAs !== "followUp")
	)
		throw new Error("malformed terminal wake");
	return {
		message: {
			customType: message.customType,
			content: message.content,
			display: message.display,
			...(message.details === undefined ? {} : { details: message.details }),
		},
		options: { triggerTurn: options.triggerTurn, deliverAs: options.deliverAs },
	};
}

/** On the brain: a terminal wake taken from the inbox becomes the same `sendMessage` the fused session makes. */
export function deliverTerminalWake(wake: WakeEvent, sendMessage: SendMessage): void {
	if (wake.source !== TERMINAL_WAKE_SOURCE) throw new Error(`not a terminal wake: ${wake.source}`);
	const { message, options } = terminalPayload(wake.payload);
	sendMessage(message, options);
}
