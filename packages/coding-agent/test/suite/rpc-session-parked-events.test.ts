import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { opened } from "./rpc-inprocess-host-metrics.ts";
import { createInProcessRig } from "./rpc-inprocess-host-support.ts";

const roots: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function directory() {
	const root = await mkdtemp(join(tmpdir(), "rpc-parked-events-"));
	roots.push(root);
	return root;
}

it("parks only the last retained attachment and resumes only the first returning attachment", async () => {
	const dir = await directory();
	await using rig = createInProcessRig(dir);
	const path = join(dir, "retained.jsonl");
	const first = opened(await rig.open("a", { cwd: dir, sessionPath: path, retain_on_disconnect: true }), 0);
	const runtime = rig.registry.peek(first.sessionId)?.runtime;
	if (!runtime) throw new Error("Expected in-process runtime");
	const emit = vi.spyOn(runtime.session.extensionRunner, "emit");
	vi.spyOn(runtime.session.extensionRunner, "hasHandlers").mockReturnValue(true);
	await rig.open("b", { cwd: dir, sessionPath: path });
	await rig.drop("a");
	expect(emit).not.toHaveBeenCalled();

	await rig.drop("b");
	expect(emit.mock.calls.map(([event]) => event.type)).toEqual(["session_parked"]);
	await rig.drop("b");
	expect(emit).toHaveBeenCalledTimes(1);
	await rig.open("c", { cwd: dir, sessionPath: path });
	await rig.open("d", { cwd: dir, sessionPath: path });
	expect(emit.mock.calls.map(([event]) => event.type)).toEqual(["session_parked", "session_resumed"]);
});

it("does not emit parked for an ordinary non-retained session", async () => {
	const dir = await directory();
	await using rig = createInProcessRig(dir);
	const first = opened(await rig.open("a", { cwd: dir, sessionPath: join(dir, "ordinary.jsonl") }), 0);
	const runtime = rig.registry.peek(first.sessionId)?.runtime;
	if (!runtime) throw new Error("Expected in-process runtime");
	const emit = vi.spyOn(runtime.session.extensionRunner, "emit");
	await rig.drop("a");
	expect(emit.mock.calls.some(([event]) => String(event.type) === "session_parked")).toBe(false);
	expect(rig.registry.size).toBe(0);
});

it("finishes the park handlers before delivering resume on a concurrent reattach", async () => {
	const dir = await directory();
	await using rig = createInProcessRig(dir);
	const path = join(dir, "race.jsonl");
	const first = opened(await rig.open("a", { cwd: dir, sessionPath: path, retain_on_disconnect: true }), 0);
	const runtime = rig.registry.peek(first.sessionId)?.runtime;
	if (!runtime) throw new Error("Expected in-process runtime");
	const order: string[] = [];
	const parked = Promise.withResolvers<void>();
	vi.spyOn(runtime.session.extensionRunner, "hasHandlers").mockReturnValue(true);
	vi.spyOn(runtime.session.extensionRunner, "emit").mockImplementation(async (event) => {
		order.push(String(event.type));
		if (String(event.type) === "session_parked") {
			await parked.promise;
			order.push("park-complete");
		}
		return undefined;
	});
	const dropping = rig.drop("a");
	const reattaching = rig.open("b", { cwd: dir, sessionPath: path });
	parked.resolve();
	await Promise.all([dropping, reattaching]);
	expect(order).toEqual(["session_parked", "park-complete", "session_resumed"]);
});
