import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { FauxResponseFactory } from "@earendil-works/pi-ai/compat";

/** A response gate for the registered faux provider; no replacement stream or agent. */
export function heldResponse(message: AssistantMessage) {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	const response: FauxResponseFactory = async () => {
		entered.resolve();
		await released.promise;
		return message;
	};
	return { response, entered: entered.promise, release: () => released.resolve() };
}

/** A handler that can stay pending without leaving a timer or an I/O handle behind. */
export function heldHandler() {
	const entered = Promise.withResolvers<void>();
	const released = Promise.withResolvers<void>();
	return {
		entered: entered.promise,
		run: async () => {
			entered.resolve();
			await released.promise;
		},
		release: () => released.resolve(),
	};
}

export async function handlerHop(race: boolean): Promise<void> {
	const hop = Promise.resolve().then(() => undefined);
	if (race) await Promise.race([hop, new Promise<never>(() => {})]);
	else await hop;
}
