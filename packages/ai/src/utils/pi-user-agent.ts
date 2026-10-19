import type * as NodeOs from "node:os";
import type { ProviderHeaders } from "../types.ts";
import { getWireIdentity } from "../wire-identity.ts";

type ProcessWithOsBuiltinModule = typeof process & {
	getBuiltinModule?: (id: "node:os") => typeof NodeOs;
};

function loadNodeOs(): typeof NodeOs | null {
	if (typeof process === "undefined" || !(process.versions?.node || process.versions?.bun)) {
		return null;
	}
	return (process as ProcessWithOsBuiltinModule).getBuiltinModule?.("node:os") ?? null;
}

// Keep runtime OS loading browser-safe. A top-level runtime import of node:os breaks browser/Vite builds.
const nodeOs = loadNodeOs();

export function getPiUserAgent(): string {
	// The product token follows the wire identity a distribution sets at startup, so a
	// rebranded install does not keep telling every provider it is the engine (senpi#3720).
	const identity = getWireIdentity();
	return nodeOs ? `${identity} (${nodeOs.platform()} ${nodeOs.release()}; ${nodeOs.arch()})` : `${identity} (browser)`;
}

export function forcePiUserAgent(headers: ProviderHeaders): void {
	for (const name of Object.keys(headers)) {
		if (name.toLowerCase() === "user-agent") delete headers[name];
	}
	headers["User-Agent"] = getPiUserAgent();
}
