/**
 * A handoff's one-shot publication token (code-yeongyu/oh-my-openagent#10091). The handoff writes it into the
 * successor's generation directory before spawning it. The successor's supervisor consumes it with one rename
 * as the last step before it renames its socket over the public path (`consumePublishToken`), and the handoff
 * revokes it with one rename of the same file when its readiness window closes. Exactly one rename wins: a
 * revoked successor never publishes, and a handoff that lost the race follows the publication instead of
 * stopping the generation that made it.
 */
import { randomUUID } from "node:crypto";
import { access, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PUBLISH_TOKEN_FILE = "publish-token";

export async function createPublishToken(generationDir: string): Promise<string> {
	const token = join(generationDir, PUBLISH_TOKEN_FILE);
	await writeFile(token, randomUUID(), { flag: "wx", mode: 0o600 });
	return token;
}

/** `revoked`: the successor can no longer publish. `consumed`: it took the token first and is publishing. */
export async function revokePublishToken(token: string): Promise<"revoked" | "consumed"> {
	try {
		await rename(token, `${token}.revoked`);
		return "revoked";
	} catch (cause) {
		if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
		return (await present(`${token}.consumed`)) ? "consumed" : "revoked";
	}
}

async function present(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
