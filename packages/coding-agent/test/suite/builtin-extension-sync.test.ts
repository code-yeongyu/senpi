import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const builtinRoot = join(process.cwd(), "src", "core", "extensions", "builtin");

describe("synced builtin extensions", () => {
	it("records the external source package versions used for vendored builtins", () => {
		const manifestPath = join(builtinRoot, "external-versions.json");

		expect(existsSync(manifestPath)).toBe(true);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
			extensions?: Record<string, { packageName?: string; version?: string; source?: string }>;
		};

		expect(manifest.extensions?.["bash-timeout"]?.packageName).toBe("pi-bash-timeout");
		expect(manifest.extensions?.["bash-timeout"]?.version).toBe("0.1.1");
		expect(manifest.extensions?.todowrite?.packageName).toBe("pi-todotools");
		expect(manifest.extensions?.todowrite?.version).toBe("0.1.1");
	});
});
