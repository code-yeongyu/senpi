import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { referenceRoot, resolveReference, SECRET } from "./3858-reference-support.ts";

// #3858: setup reads this manifest field from the installed engine before it writes reference objects.
describe("reference object capability signal (#3858)", () => {
	it("declares level 1 alongside a resolver for every level-1 reference kind", async () => {
		const manifest: unknown = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
		expect(manifest).toMatchObject({ senpiCapabilities: { configReferenceObjects: 1 } });
		const files = referenceRoot();
		try {
			const path = files.file("capability");
			const env = { CAPABILITY_3858: SECRET };
			expect(await resolveReference({ $file: path }, { root: files.root })).toBe(SECRET);
			expect(await resolveReference({ $env: "CAPABILITY_3858" }, { root: files.root, env })).toBe(SECRET);
			expect(await resolveReference({ $concat: ["Bearer ", { $file: path }] }, { root: files.root })).toBe(
				`Bearer ${SECRET}`,
			);
		} finally {
			files.close();
		}
	});
});
