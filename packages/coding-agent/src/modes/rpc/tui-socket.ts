/**
 * The naming contract of a terminal's control socket, `t-<sha256(instanceId)[:16]>.sock`, and the
 * one client rule it carries: a TUI endpoint authenticates every connection with the 32-byte secret
 * beside it (`socket-transport.ts`), on every platform, so a client sends that secret first. Hosts
 * keep their own rule (a handshake on win32 only), which is why the decision reads the name.
 */
import { createHash } from "node:crypto";
import { basename } from "node:path";

const TUI_SOCKET_NAME = /^t-[0-9a-f]{16}\.sock$/;

export function tuiSocketName(instanceId: string): string {
	return `t-${createHash("sha256").update(instanceId, "utf8").digest("hex").slice(0, 16)}.sock`;
}

export function isTuiControlSocket(socket: string): boolean {
	return TUI_SOCKET_NAME.test(basename(socket));
}

export function socketNeedsHandshake(socket: string, platform: NodeJS.Platform = process.platform): boolean {
	return platform === "win32" || isTuiControlSocket(socket);
}
