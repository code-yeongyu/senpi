import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { createCliRuntimeFactory } from "../../../src/main.ts";
import { SessionCommandRouter } from "../../../src/modes/rpc/session-command-router.ts";
import { SessionEventWriter } from "../../../src/modes/rpc/session-event-writer.ts";
import { RpcSessionRegistry } from "../../../src/modes/rpc/session-registry.ts";
import { opened } from "../rpc-inprocess-host-metrics.ts";

// senpi #1850. Originally surfaced by an adversarial review claim: "a session created WITHOUT a path never registers the
// file it created in `reservations`, so opening that same path builds a SECOND
// runtime instead of attaching."
it("attaches to a pathless session when its created file is opened by path", async () => {
	const scratch = await mkdtemp(join(tmpdir(), "senpi-f2-pathless-"));
	const cwd = join(scratch, "cwd");
	const agentDir = join(scratch, "agent");
	await mkdir(cwd);
	await mkdir(agentDir);
	const parsed = parseArgs([
		"--mode",
		"rpc",
		"--multi-session",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
	]);
	const registry = new RpcSessionRegistry({
		agentDir,
		createRuntime: createCliRuntimeFactory({ parsed, cwd, agentDir, appMode: "rpc" }),
		closeGraceMs: 1000,
	});
	let latest: unknown;
	const writer = new SessionEventWriter((line) => {
		latest = JSON.parse(line);
	});
	const router = new SessionCommandRouter(registry, writer, { cwd });
	try {
		// Given: a session opened with NO sessionPath, which creates its own file.
		expect(await router.handle({ type: "open_session", cwd })).toBeUndefined();
		await writer.flush();
		const pathless = opened(latest, 0);
		const createdFile = pathless.state.sessionFile;
		expect(createdFile).toBeTruthy();
		expect(registry.size).toBe(1);

		// When: that exact file is opened by path.
		expect(await router.handle({ type: "open_session", cwd, sessionPath: createdFile })).toBeUndefined();
		await writer.flush();
		const second = opened(latest, 0);

		// Then: it ATTACHES to the same session; no second runtime is built.
		expect(second.sessionId).toBe(pathless.sessionId);
		expect(second.attached).toBe(true);
		expect(registry.size).toBe(1);
		expect(registry.peek(pathless.sessionId)?.attachments).toBe(2);
	} finally {
		await router.dispose();
		await rm(scratch, { recursive: true, force: true });
	}
}, 300_000);
