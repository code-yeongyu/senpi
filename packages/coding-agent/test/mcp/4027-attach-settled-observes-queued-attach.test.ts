import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getMcpService, resetMcpServiceForTests } from "../../src/core/extensions/builtin/mcp/service.ts";
import { attach, cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
	resetMcpServiceForTests();
});

afterEach(async () => {
	await getMcpService().dispose("quit");
	resetMcpServiceForTests();
	await cleanupRoots(cleanupTasks);
});

describe("whenAttachSettled observes an attach that is still running (senpi#4027)", () => {
	it("#given an eager server that never answers initialize #when whenAttachSettled is called while its attach is still running #then it reports timeout, never settled", async () => {
		// given
		const root = makeRoot("attach-settled-4027", cleanupTasks);
		setConfig(root, {
			"never-ready": {
				type: "stdio",
				command: process.execPath,
				args: ["-e", "setInterval(() => {}, 1 << 30)"],
				lifecycle: "eager",
				connectTimeoutMs: 60_000,
			},
		});
		const service = getMcpService();

		// when: the attach has started (it queues synchronously) but has not finished its startup race yet
		const attaching = attach(service, root, "startup");
		const observed = await service.whenAttachSettled(50);
		await attaching;

		// then
		expect(observed).toBe("timeout");
		expect(await service.whenAttachSettled(50)).toBe("timeout");
	});
});
