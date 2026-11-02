import { describe, expect, it, vi } from "vitest";
import { Agent, createInternalAgentChannel, type OrderedAgentRecord } from "../src/index.ts";

describe("construction-time internal channel capability #4349", () => {
	it("cannot attach a fresh channel to an existing Agent", async () => {
		const agent = new Agent({
			streamFn: () => {
				throw new Error("fixture provider failed");
			},
		});
		const channel = createInternalAgentChannel();
		const records: OrderedAgentRecord[] = [];
		const release = channel.subscribe((record) => {
			records.push(record);
		});
		try {
			await agent.prompt("go");
			expect(records).toEqual([]);
		} finally {
			release();
		}
	});
	it("delivers ordered records only to its construction channel without exposing an attach path", async () => {
		const globalKeys = Reflect.ownKeys(globalThis);
		const registry = vi.spyOn(Symbol, "for");
		const channel = createInternalAgentChannel();
		const records: OrderedAgentRecord[] = [];
		const agent = new Agent({
			internalChannel: channel,
			streamFn: () => {
				throw new Error("fixture provider failed");
			},
		});
		try {
			expect(registry).not.toHaveBeenCalled();
			expect(Reflect.ownKeys(globalThis)).toEqual(globalKeys);
			for (const owner of [agent, Agent.prototype]) {
				expect(Object.getOwnPropertySymbols(owner)).toEqual([]);
				for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(owner))) {
					expect(key).not.toMatch(/internal|channel/i);
					expect(descriptor.value).not.toBe(channel);
					expect(descriptor.value).not.toBe(channel.subscribe);
				}
			}
			const release = channel.subscribe((record) => {
				records.push(record);
			});
			try {
				await agent.prompt("go");
				expect(records.length).toBeGreaterThan(0);
				expect(records.map((record) => record.sequence)).toEqual(records.map((_, index) => index + 1));
			} finally {
				release();
			}
		} finally {
			registry.mockRestore();
		}
	});
});
