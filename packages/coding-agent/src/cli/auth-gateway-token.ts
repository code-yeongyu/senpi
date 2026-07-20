import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startAuthGatewayTransport } from "../core/auth-gateway-transport.ts";

const GATEWAY_TOKEN_FILE = "auth-gateway.token";

export function gatewayTokenPath(agentDir: string): string {
	return join(agentDir, GATEWAY_TOKEN_FILE);
}

export async function gatewayToken(agentDir: string): Promise<string> {
	const path = gatewayTokenPath(agentDir);
	const current = await readToken(path);
	if (current !== undefined) return current;
	const handle = await startAuthGatewayTransport({ auth: { kind: "token-file", path }, port: 0 });
	try {
		const token = await readToken(path);
		if (token === undefined) throw new Error("Unable to create gateway token safely");
		return token;
	} finally {
		await handle.close();
	}
}

export async function replaceGatewayToken(agentDir: string): Promise<string> {
	const path = gatewayTokenPath(agentDir);
	await mkdir(agentDir, { mode: 0o700, recursive: true });
	await chmod(agentDir, 0o700);
	const token = randomBytes(32).toString("base64url");
	const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
	await writeFile(temporary, `${token}\n`, { flag: "wx", mode: 0o600 });
	await chmod(temporary, 0o600);
	await rename(temporary, path);
	await chmod(path, 0o600);
	return token;
}

export async function readToken(path: string): Promise<string | undefined> {
	try {
		const token = (await readFile(path, "utf8")).trim();
		return token.length === 0 ? undefined : token;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}
