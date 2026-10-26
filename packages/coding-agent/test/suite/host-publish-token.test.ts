// code-yeongyu/oh-my-openagent#10091: a handoff's publication token is taken by exactly one side. The successor's
// supervisor consumes it right before its rename; the handoff revokes it when its readiness window closes.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPublishToken, revokePublishToken } from "../../src/modes/rpc/host-publish-token.ts";
import { consumePublishToken } from "../../src/modes/rpc/socket-ownership.ts";

const dirs: string[] = [];
afterEach(async () => {
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function token(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-publish-token-"));
	dirs.push(dir);
	return createPublishToken(dir);
}

describe("a handoff's publication token", () => {
	it("cannot be consumed once the handoff has revoked it", async () => {
		const publish = await token();

		expect(await revokePublishToken(publish)).toBe("revoked");
		expect(await consumePublishToken(publish)).toBe(false);
	});

	it("tells the handoff that a successor which consumed it first is publishing", async () => {
		const publish = await token();

		expect(await consumePublishToken(publish)).toBe(true);
		expect(await revokePublishToken(publish)).toBe("consumed");
		expect(await consumePublishToken(publish)).toBe(false);
	});
});
