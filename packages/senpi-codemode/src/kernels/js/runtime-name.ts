import { basename } from "node:path";

/** "bun" or "node" from an executable path; undefined for anything else (a compiled senpi binary, for one). */
export function runtimeNameOf(command: string): "bun" | "node" | undefined {
	const name = basename(command).replace(/\.(exe|cmd|bat)$/i, "");
	return name === "bun" || name === "node" ? name : undefined;
}
