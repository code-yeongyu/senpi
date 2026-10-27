import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// senpi#4272 / S03b-1b-I-a staging contract: I-b removes this guard when it wires the codec.
// Check references, not just calls: aliases, namespace imports, re-exports, and stored values count.
it("keeps every structured codec entry point out of production until the index increment", async () => {
	const src = fileURLToPath(new URL("../../../src", import.meta.url));
	const owner = join("modes", "rpc", "compact-values.ts");
	const source = await readFile(join(src, owner), "utf8");
	const names = [...source.matchAll(/export\s+(?:class|interface|type|function|const)\s+(\w+)/g)].map(
		(match) => match[1],
	);
	expect(names.length).toBeGreaterThan(0);
	const reference = new RegExp(`\\b(?:${names.join("|")})\\b|compact-values(?:\\.[cm]?ts|\\.[cm]?js)?`);
	const offenders: string[] = [];
	for (const file of await readdir(src, { recursive: true, encoding: "utf8" })) {
		if (file === owner || !/\.[cm]?tsx?$/.test(file)) continue;
		if (reference.test(await readFile(join(src, file), "utf8"))) offenders.push(file);
	}
	expect(offenders, "the staged codec gained a production reference").toEqual([]);
});
