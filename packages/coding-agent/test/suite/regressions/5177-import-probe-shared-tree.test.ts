import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeImportGraph } from "../../helpers/esm-import-graph-probe.ts";

// senpi#5177: the import-graph probe linked packages/coding-agent/node_modules/@earendil-works/pi-ai
// into the checkout it probed and removed the link afterwards. Host children spawned by other test
// files in the same shard resolve pi-ai through that path, and one whose resolution straddled the
// removal died with ERR_MODULE_NOT_FOUND for .../coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js.
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("import-graph probe (#5177)", () => {
	it("leaves the dependency tree of the checkout it probes untouched", () => {
		// Given: a checkout whose entry records, at import time, whether the nested link exists
		const root = mkdtempSync(join(tmpdir(), "probe-5177-"));
		roots.push(root);
		mkdirSync(join(root, "packages", "ai"), { recursive: true });
		const link = join(root, "packages", "coding-agent", "node_modules", "@earendil-works", "pi-ai");
		const seen = join(root, "seen.txt");
		const entry = join(root, "entry.mjs");
		writeFileSync(
			entry,
			`import { existsSync, writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(seen)}, existsSync(${JSON.stringify(link)}) ? "linked" : "absent");\n`,
		);

		// When
		probeImportGraph(root, entry);

		// Then: nothing was linked while the probe ran, and nothing was left behind
		expect(readFileSync(seen, "utf8")).toBe("absent");
		expect(existsSync(join(root, "packages", "coding-agent"))).toBe(false);
	});
});
