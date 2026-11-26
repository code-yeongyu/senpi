import { homedir } from "node:os";
import { resolve } from "node:path";
import { checkIdentityAccess } from "@code-yeongyu/senpi-machine-ops";
import { resolveReadPath } from "../tools/path-utils.ts";

export async function checkToolIdentityPath(name: string, params: unknown, root: string): Promise<void> {
	if (name !== "read" && name !== "grep") return;
	if (!params || typeof params !== "object" || !("path" in params) || typeof params.path !== "string") return;
	const path = params.path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, () => process.env.HOME || homedir());
	await checkIdentityAccess(name === "read" ? resolveReadPath(path, root) : resolve(root, path));
}
