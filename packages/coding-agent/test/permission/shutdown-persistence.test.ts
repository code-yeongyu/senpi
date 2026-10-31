/**
 * MEDIUM 3 + MEDIUM 4 (Opus #3301 review): shutdown persistence must track rules by identity,
 * not by index, and a failed "Always" persist must not break the call or lose the rule.
 *
 * Pre-fix, `index.ts` computed the shutdown append as `getApproved().slice(initialApprovedCount)`:
 * rules another session appended landed past the fixed index and were re-appended as duplicates,
 * and deleting or compacting the store shrank the persisted prefix so the slice dropped this
 * session's unsaved answers or resurrected revoked ones. A `persistAlways` write failure threw out
 * of the answered tool call and the rule was never retried.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { approvedStorePath } from "../../src/core/extensions/builtin/permission-system/storage.ts";
import { closeLiveHosts, createLiveHost, SHELL_FIXTURE_INPUT } from "./live-permission-host.ts";

afterEach(closeLiveHosts);

const SHELL_RULE = { permission: "shell_fixture", action: "allow" } as const;

async function answerAlwaysAndFinish(host: Awaited<ReturnType<typeof createLiveHost>>): Promise<void> {
	const turn = host.runProbe("shell_fixture", SHELL_FIXTURE_INPUT, "run shell");
	const prompt = await host.waitForPrompt();
	prompt.resolve("Allow always");
	await turn;
	expect(host.toolResultIsError("shell_fixture")).toBe(false);
}

describe("MEDIUM 3: shutdown persistence tracks rules by identity", () => {
	it("a rule another session persisted is not duplicated at this session's shutdown", async () => {
		// given an ask session that answered Allow always (persisted at answer time, senpi#2465)
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();
		await answerAlwaysAndFinish(host);
		const storePath = approvedStorePath(host.agentDir, host.cwd);
		const before = readFileSync(storePath, "utf-8").trim().split("\n");

		// when the session shuts down
		await host.runtimeHost.dispose();

		// then the rule this session already persisted is not re-appended
		const after = readFileSync(storePath, "utf-8").trim().split("\n");
		expect(after).toEqual(before);
		expect(after).toHaveLength(1);
	}, 30_000);

	it("deleting the store mid-session drops neither unsaved answers nor honors revocations at shutdown", async () => {
		// given an ask session whose first Always answer could NOT be persisted (read-only store dir)
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();
		const storePath = approvedStorePath(host.agentDir, host.cwd);
		const storeDir = storePath.slice(0, storePath.lastIndexOf("/"));
		mkdirSync(storeDir, { recursive: true });
		chmodSync(storeDir, 0o500);
		await answerAlwaysAndFinish(host);
		expect(existsSync(storePath)).toBe(false);

		// when the store is deleted (user revocation) while that answer is still only in memory,
		// and the session shuts down without the directory ever becoming writable
		rmSync(storePath, { force: true });
		await host.runtimeHost.dispose();
		chmodSync(storeDir, 0o700);

		// then the revocation stands: the shutdown retry failed too, and nothing was resurrected
		expect(existsSync(storePath)).toBe(false);
	}, 30_000);
});

describe("MEDIUM 4: a failed Always persist is survived and retried", () => {
	it("an unwritable store dir does not break the answered call, and shutdown retries the write", async () => {
		// given an ask session whose approvals-store directory is made unwritable after startup
		const host = await createLiveHost({ preset: "ask" });
		await host.bind();
		const storePath = approvedStorePath(host.agentDir, host.cwd);
		const storeDir = storePath.slice(0, storePath.lastIndexOf("/"));
		mkdirSync(storeDir, { recursive: true });
		chmodSync(storeDir, 0o500);

		// when the user answers Allow always (the persist fails behind the prompt)
		await answerAlwaysAndFinish(host);
		expect(existsSync(storePath)).toBe(false);

		// and when the directory becomes writable again and the session shuts down
		chmodSync(storeDir, 0o700);
		await host.runtimeHost.dispose();

		// then the shutdown retry persisted the answer
		expect(existsSync(storePath)).toBe(true);
		const lines = readFileSync(storePath, "utf-8").trim().split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0])).toMatchObject(SHELL_RULE);
	}, 30_000);
});
