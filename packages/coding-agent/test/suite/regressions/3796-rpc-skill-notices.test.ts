// #3796: each attached presentation must receive the retained warning snapshot.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createRpcConnectionHandler, type RpcConnectionHandler } from "../../../src/modes/rpc/connection-handler.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

const handlers: RpcConnectionHandler[] = [];
let harness: Harness | undefined;
let root: string | undefined;
afterEach(async () => {
	for (const handler of handlers.splice(0)) await handler.dispose();
	harness?.cleanup();
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
});

it("replays a blocked-link warning to two clients and a late attach", async () => {
	root = mkdtempSync(join(tmpdir(), "senpi-3796-notices-"));
	vi.stubEnv("HOME", root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const selected = join(cwd, ".senpi", "skills");
	const outside = join(root, "outside");
	mkdirSync(selected, { recursive: true });
	mkdirSync(join(cwd, ".git"));
	mkdirSync(agentDir);
	mkdirSync(outside);
	writeFileSync(join(outside, "SKILL.md"), "---\nname: escape\ndescription: synthetic\n---\n");
	symlinkSync(outside, join(selected, "escape"));
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
	await loader.reload();
	const resourceLoader = { ...createTestResourceLoader(), getSkills: () => loader.getSkills() };
	harness = await createHarness({ resourceLoader });
	const runtime = {
		session: harness.session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
	for (let index = 0; index < 3; index++) {
		const chunks: string[] = [];
		const handler = createRpcConnectionHandler(runtime, {
			writeRaw: (chunk) => chunks.push(chunk),
			waitForBackpressure: async () => {},
		});
		handlers.push(handler);
		await handler.ready;
		const records = chunks
			.join("")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
		expect(records.filter((record) => record.method === "notify" && record.notifyType === "warning")).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("Blocked skill link") }),
		);
	}
});
