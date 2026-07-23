import { EventEmitter } from "node:events";
import { bindToProviderScope } from "@earendil-works/pi-ai/node/provider-scope";

export interface EventBus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface EventBusController extends EventBus {
	clear(): void;
}

export function createEventBus(): EventBusController {
	const emitter = new EventEmitter();
	return {
		emit: (channel, data) => {
			emitter.emit(channel, data);
		},
		on: (channel, handler) => {
			const scopedHandler = bindHandler(handler);
			const safeHandler = async (data: unknown) => {
				try {
					await scopedHandler(data);
				} catch (err) {
					console.error(`Event handler error (${channel}):`, err);
				}
			};
			emitter.on(channel, safeHandler);
			return () => emitter.off(channel, safeHandler);
		},
		clear: () => {
			emitter.removeAllListeners();
		},
	};
}

function bindHandler<TArgs extends unknown[], TResult>(
	handler: (...args: TArgs) => TResult,
): (...args: TArgs) => TResult {
	try {
		return bindToProviderScope(handler);
	} catch {
		return handler;
	}
}
