import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { dirname } from "node:path";

export type WebSocketListenerAuth =
	| { readonly kind: "off" }
	| { readonly kind: "token-file"; readonly path: string }
	| { readonly kind: "token-value"; readonly token: string };

export type ResolvedWebSocketListenerAuth =
	| { readonly kind: "off" }
	| { readonly kind: "bearer"; readonly token: string; readonly path?: string };

export async function resolveWebSocketListenerAuth(options: {
	readonly auth?: WebSocketListenerAuth;
	readonly stderr: Pick<NodeJS.WriteStream, "write">;
	readonly defaultTokenPath?: string;
	readonly tokenLogLabel: string;
}): Promise<ResolvedWebSocketListenerAuth> {
	const { auth, defaultTokenPath, stderr, tokenLogLabel } = options;
	if (auth?.kind === "off" || (auth === undefined && defaultTokenPath === undefined)) return { kind: "off" };
	if (auth?.kind === "token-value") return { kind: "bearer", token: auth.token };
	const path = auth?.kind === "token-file" ? auth.path : defaultTokenPath;
	if (path === undefined) return { kind: "off" };
	const token = auth?.kind === "token-file" ? await readTokenFile(path) : await ensureTokenFile(path);
	// Fail closed: an empty token would authorize any `Authorization: Bearer `
	// request. Never start a listener with a blank expected token.
	if (token.length === 0) {
		throw new Error(`app-server ws auth token file is empty: ${path}`);
	}
	stderr.write(`${tokenLogLabel}: ${path}\n`);
	return { kind: "bearer", token, path };
}

export function isWebSocketRequestAuthorized(request: IncomingMessage, auth: ResolvedWebSocketListenerAuth): boolean {
	if (auth.kind === "off") return true;
	// Defense in depth: an empty expected token must never authorize anything,
	// regardless of how it was produced.
	if (auth.token.length === 0) return false;
	const header = request.headers.authorization;
	if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
	return tokensEqual(header.slice("Bearer ".length), auth.token);
}

async function readTokenFile(path: string): Promise<string> {
	return (await readFile(path, "utf8")).trim();
}

async function ensureTokenFile(path: string): Promise<string> {
	try {
		const existing = await readTokenFile(path);
		// A truncated/empty auto-managed token file (e.g. a crashed prior write)
		// self-heals by regenerating rather than failing the daemon startup.
		if (existing.length > 0) return existing;
	} catch (error: unknown) {
		if (!isNodeErrorCode(error, "ENOENT")) throw error;
	}
	const token = randomBytes(32).toString("hex");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${token}\n`, { mode: 0o600 });
	await chmod(path, 0o600);
	return token;
}

function tokensEqual(actual: string, expected: string): boolean {
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}
