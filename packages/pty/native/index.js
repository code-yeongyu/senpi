import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

export function loadNativePty() {
	const host = `${process.platform}-${process.arch}`;
	const attemptedPath = join(dirname(fileURLToPath(import.meta.url)), "prebuilds", host, "pi-pty.node");
	try {
		return {
			native: require(attemptedPath),
			diagnostic: null,
		};
	} catch (error) {
		const cause = error instanceof Error ? error.message : String(error);
		return {
			native: null,
			diagnostic: {
				code: "native-unavailable",
				host,
				attemptedPath,
				message: `No @earendil-works/pi-pty native prebuild is available for ${host}.`,
				cause,
			},
		};
	}
}

export const nativePty = loadNativePty();
