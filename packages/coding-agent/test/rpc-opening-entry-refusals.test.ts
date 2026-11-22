import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RpcSessionRegistry } from "../src/modes/rpc/session-registry.ts";

// senpi#3282 review round 9: a reclaim reacting to an open_in_progress rejection aborts and closes
// whatever is listed at the path. What keeps a still-opening session alive is that the host refuses
// both commands on an "opening" entry; this pins that refusal as an invariant.

const dirs: string[] = [];

afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("an opening entry refuses abort and close", () => {
	test("abort and close on a still-opening session are unknown_session and leave the entry opening", async () => {
		const dir = await mkdtemp(join(tmpdir(), "rpc-opening-"));
		dirs.push(dir);
		let failConstruction!: (cause: Error) => void;
		const construction = new Promise<never>((_resolve, reject) => {
			failConstruction = reject;
		});
		let constructionStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			constructionStarted = resolve;
		});
		const registry = new RpcSessionRegistry({
			agentDir: dir,
			createRuntime: () => {
				constructionStarted();
				return construction;
			},
		});
		const opening = registry.openSession({ cwd: dir, sessionPath: join(dir, "opening.jsonl") });
		const settled = opening.then(
			() => "opened",
			() => "failed",
		);
		await started;

		const [row] = registry.list();
		expect(row?.status).toBe("opening");
		const handle = row!.sessionId;

		expect(() => registry.getForCommand(handle, "abort")).toThrow(/unknown_session/);
		expect(() => registry.beginClose(handle)).toThrow(/unknown_session/);
		expect(registry.peek(handle)?.state).toBe("opening");

		failConstruction(new Error("construction failed"));
		expect(await settled).toBe("failed");
	});
});
