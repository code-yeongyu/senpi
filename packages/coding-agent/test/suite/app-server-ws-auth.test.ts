import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	isWebSocketRequestAuthorized,
	resolveWebSocketListenerAuth,
} from "../../src/modes/app-server/transports/websocket-auth.ts";

const dirs: string[] = [];
const silentStderr = { write: () => true };

afterEach(async () => {
	while (dirs.length > 0) {
		const dir = dirs.pop();
		if (dir) await rm(dir, { recursive: true, force: true });
	}
});

async function scratchDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "senpi-ws-auth-"));
	dirs.push(dir);
	return dir;
}

function bearerRequest(value: string): IncomingMessage {
	return { headers: { authorization: `Bearer ${value}` } } as unknown as IncomingMessage;
}

describe("app-server websocket auth", () => {
	it("never authorizes against an empty expected token", () => {
		// Given: a resolved bearer auth whose token is empty (the fail-open hazard).
		const auth = { kind: "bearer", token: "" } as const;

		// Then: neither an empty nor any other Bearer value is accepted.
		expect(isWebSocketRequestAuthorized(bearerRequest(""), auth)).toBe(false);
		expect(isWebSocketRequestAuthorized(bearerRequest("anything"), auth)).toBe(false);
	});

	it("authorizes only the exact configured token", () => {
		const auth = { kind: "bearer", token: "s3cret-token" } as const;
		expect(isWebSocketRequestAuthorized(bearerRequest("s3cret-token"), auth)).toBe(true);
		expect(isWebSocketRequestAuthorized(bearerRequest("wrong"), auth)).toBe(false);
		expect(isWebSocketRequestAuthorized({ headers: {} } as IncomingMessage, auth)).toBe(false);
	});

	it("refuses to start with an explicit but empty token file", async () => {
		// Given: --ws-auth points at a blank token file.
		const dir = await scratchDir();
		const path = join(dir, "ws-token");
		await writeFile(path, "   \n");

		// Then: resolution fails closed instead of yielding a blank bearer token.
		await expect(
			resolveWebSocketListenerAuth({
				auth: { kind: "token-file", path },
				stderr: silentStderr,
				tokenLogLabel: "test token",
			}),
		).rejects.toThrow(/empty/);
	});

	it("regenerates an empty auto-managed token file instead of failing open", async () => {
		// Given: the default token path exists but was truncated to empty.
		const dir = await scratchDir();
		const path = join(dir, "app-server", "ws-token");
		await mkdir(join(dir, "app-server"), { recursive: true });
		await writeFile(path, "");

		// When: auth resolves with the empty file as the default token path.
		const resolved = await resolveWebSocketListenerAuth({
			defaultTokenPath: path,
			stderr: silentStderr,
			tokenLogLabel: "test token",
		});

		// Then: a fresh non-empty token is minted (self-heal), never a blank one.
		expect(resolved.kind).toBe("bearer");
		if (resolved.kind === "bearer") {
			expect(resolved.token.length).toBeGreaterThan(0);
			expect(isWebSocketRequestAuthorized(bearerRequest(resolved.token), resolved)).toBe(true);
			expect(isWebSocketRequestAuthorized(bearerRequest(""), resolved)).toBe(false);
		}
	});
});
