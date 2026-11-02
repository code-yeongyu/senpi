import type { EngineTrustMarker } from "../../src/engine-trust/index.ts";

export const serverMarker: EngineTrustMarker = {
	v: 1,
	file: "/home/u/.omo/engine-trust/aaaa.pem",
	sha256: "a".repeat(64),
	automatic: "os",
	fallbackReason: null,
	owner: "server",
	user: null,
	defaults: {
		file: "/home/u/.omo/engine-trust/defaults/empty.pem",
		dir: "/home/u/.omo/engine-trust/defaults/empty.d",
	},
	restore: { NODE_USE_SYSTEM_CA: "1", SSL_CERT_FILE: null, BUN_OPTIONS: "--smol" },
};

export const standaloneMarker: EngineTrustMarker = {
	...serverMarker,
	automatic: "fallback",
	fallbackReason: "helper-timeout",
	owner: "standalone",
	user: "b".repeat(64),
	restore: {},
};
