import { expect, it, onTestFinished } from "vitest";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";

it("does not deliver an asynchronous old-owner response to a reused routing ID", async () => {
	// Given: A owns a response that is waiting on host reconciliation.
	const stdout: string[] = [];
	const original: string[] = [];
	const replacement: string[] = [];
	const other: string[] = [];
	const writer = new SessionEventWriter((line) => stdout.push(line));
	onTestFinished(() => {
		writer.unregisterConnection("a");
		writer.unregisterConnection("b");
	});
	writer.registerConnection("a", { writeRaw: (line) => original.push(line), waitForBackpressure: async () => {} });
	writer.registerConnection("b", { writeRaw: (line) => other.push(line), waitForBackpressure: async () => {} });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const pending = writer.withConnection("a", async () => {
		entered.resolve();
		await release.promise;
		writer.enqueue("session", {
			type: "response", command: "extension_request", id: "old", success: true,
			data: { code: "123456" },
		});
	});
	await entered.promise;

	// When: A disconnects and a different registration reuses its routing string.
	writer.unregisterConnection("a");
	writer.registerConnection("a", { writeRaw: (line) => replacement.push(line), waitForBackpressure: async () => {} });
	release.resolve();
	await pending;
	await writer.flush();

	// Then: no destination receives the old owner's synthetic secret.
	expect(replacement).toEqual([]);
	expect(other).toEqual([]);
	expect(stdout).toEqual([]);
	expect(original).toEqual([]);
	// A current response still reaches the new registration.
	writer.withConnection("a", () => writer.enqueue("session", {
		type: "response", command: "extension_request", id: "new", success: true, data: {},
	}));
	await writer.flush();
	expect(replacement).toHaveLength(1);
	expect(replacement.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ id: "new" })]);
	writer.withConnection("b", () => writer.enqueue("session", {
		type: "response", command: "extension_request", id: "b-live", success: true, data: {},
	}));
	await writer.flush();
	expect(other.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ id: "b-live" })]);
});
