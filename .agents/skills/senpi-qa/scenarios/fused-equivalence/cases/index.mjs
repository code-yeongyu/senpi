// Case registry: every `e<NN>-<slug>.mjs` module in this directory, in case-id order (plan §6.4). P0-05e adds E25-E30
// by adding their modules here; no list to edit.
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
	.filter((name) => /^e\d{2}-[a-z0-9-]+\.mjs$/.test(name))
	.sort();

export const cases = [];
for (const file of files) {
	const { default: testCase } = await import(new URL(file, import.meta.url).href);
	const expected = `E${file.slice(1, 3)}`;
	if (testCase?.id !== expected) throw new Error(`${file} must export default a case with id ${expected}`);
	cases.push(testCase);
}
