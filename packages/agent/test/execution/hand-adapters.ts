import { createMemoryStoreMedium, type MemoryStoreMedium, openMemoryStore } from "../../src/durable/store-memory.ts";
import type { HandCaseAdapters } from "../../src/execution/testing/hand-harness.ts";
import { createReliableTransport, decodeReferencePacket } from "../../src/transport/reliable-transport.ts";

/** The hand cases' host: a memory store and the in-process reference transport, on the given platform. */
export function handAdapters(platform: HandCaseAdapters["platform"]): HandCaseAdapters {
	const media = new Map<string, MemoryStoreMedium>();
	return {
		platform,
		store: {
			createMedium: async () => {
				const id = `medium-${media.size}`;
				media.set(id, createMemoryStoreMedium());
				return id;
			},
			open: async (id, options) => {
				const medium = media.get(id);
				if (medium === undefined) throw new Error(`unknown medium ${id}`);
				return openMemoryStore(medium, options);
			},
		},
		transport: {
			createSide: (clock) =>
				createReliableTransport({
					clock,
					window: 8,
					retransmitMs: 200,
					onHandlerError: (error) => {
						throw error;
					},
				}),
			decode: decodeReferencePacket,
		},
	};
}
