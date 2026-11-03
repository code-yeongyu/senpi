import { expect, it, onTestFinished } from "vitest";
import { SessionEventWriter } from "../../src/modes/rpc/session-event-writer.ts";
import { IssuedWorkerOwners, WorkerOwnerGates } from "../../src/modes/rpc/session-worker-owners.ts";

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
			type: "response",
			command: "extension_request",
			id: "old",
			success: true,
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
	writer.withConnection("a", () =>
		writer.enqueue("session", {
			type: "response",
			command: "extension_request",
			id: "new",
			success: true,
			data: {},
		}),
	);
	await writer.flush();
	expect(replacement).toHaveLength(1);
	expect(replacement.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ id: "new" })]);
	writer.withConnection("b", () =>
		writer.enqueue("session", {
			type: "response",
			command: "extension_request",
			id: "b-live",
			success: true,
			data: {},
		}),
	);
	await writer.flush();
	expect(other.map((line) => JSON.parse(line))).toEqual([expect.objectContaining({ id: "b-live" })]);
});

const sink = (lines: string[], gate?: Promise<void>) => ({
	writeRaw: (line: string) => lines.push(line),
	waitForBackpressure: () => gate ?? Promise.resolve(),
});
const reply = (id: string) => ({
	type: "response",
	command: "extension_request",
	id,
	success: true,
	data: { code: "123456" },
});

it("routes a worker reply only to the exact incarnation and live generation that captured it", async () => {
	// Given: A's worker command captured a gate; A dropped (host detach runs synchronously after unregister).
	const original: string[] = [];
	const replacement: string[] = [];
	const writer = new SessionEventWriter(() => {});
	onTestFinished(() => writer.unregisterConnection("a"));
	writer.registerConnection("a", sink(original));
	const gates = new WorkerOwnerGates();
	const isolate = new IssuedWorkerOwners();
	const wire = writer.withConnection("a", () =>
		gates.capture(writer.connectionContext, "a", { type: "extension_request" }),
	);
	if (!wire) throw new Error("no gate captured");
	const old = isolate.adopt(wire);
	writer.unregisterConnection("a");
	const notice = gates.detach(writer.connectionContext, "a");

	// When: A2 reuses the routing string and is issued a gate before the isolate hears A's late notice.
	writer.registerConnection("a", sink(replacement));
	const live = writer.withConnection("a", () =>
		gates.capture(writer.connectionContext, "a", { type: "extension_request" }),
	);
	if (!live) throw new Error("no replacement gate");
	const current = isolate.adopt(live);
	writer.connectionContext.runCaptured("a", wire, () => writer.enqueue("session", reply("old")));
	isolate.retire(notice);
	await writer.flush();

	// Then: A's gate was retired atomically before its notice, A2's gate survives it, and only A2 is answered.
	expect(notice).toEqual([{ ownerId: wire.ownerId, bindingGeneration: wire.bindingGeneration }]);
	expect(() => old.context.admit(() => "effect")).toThrow("RPC owner retired");
	expect(old.context.disconnectSignal.aborted).toBe(true);
	expect(current.context.admit(() => "effect")).toBe("effect");
	expect(current.context.disconnectSignal.aborted).toBe(false);
	expect(original).toEqual([]);
	expect(replacement).toEqual([]);
	writer.connectionContext.runCaptured("a", live, () => writer.enqueue("session", reply("new")));
	await writer.flush();
	expect(replacement.map((line) => JSON.parse(line).id)).toEqual(["new"]);
});

it("drops a targeted reply already queued behind backpressure when its generation retires before the write", async () => {
	// Given: A's sink is blocked, so a second reply waits in A's own actor queue.
	const lines: string[] = [];
	const blocked = Promise.withResolvers<void>();
	const writer = new SessionEventWriter(() => {});
	onTestFinished(() => writer.unregisterConnection("a"));
	writer.registerConnection("a", sink(lines, blocked.promise));
	const gates = new WorkerOwnerGates();
	const wire = writer.withConnection("a", () =>
		gates.capture(writer.connectionContext, "a", { type: "extension_request" }),
	);
	if (!wire) throw new Error("no gate captured");
	writer.connectionContext.runCaptured("a", wire, () => {
		writer.enqueue("session", reply("first"));
		writer.enqueue("session", reply("queued"));
	});

	// When: the binding generation retires while "queued" sits behind the backpressure wait.
	gates.retireAll();
	blocked.resolve();
	await writer.flush();

	// Then: only the reply written before retirement reached the transport.
	expect(lines.map((line) => JSON.parse(line).id)).toEqual(["first"]);
});
