import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const repo = resolve(import.meta.dir, "..");

test("keeps the provider SDK out of the Node session worker bundle", () => {
	// Given: freshly built workspace output and the production Node bundle builder.
	const bundle = join(repo, "packages/coding-agent/dist/bundle");
	// When
	const result = spawnSync("node", ["scripts/build-coding-agent-bundle.mjs"], {
		cwd: repo, encoding: "utf8", timeout: 120000,
	});
	// Then
	expect(result.status, result.stderr).toBe(0);
	const worker = readdirSync(bundle, { recursive: true }).find((path) => String(path).endsWith("session-worker.js"));
	expect(worker).toBeDefined();
	if (worker === undefined) throw new Error("Node session worker bundle is absent");
	expect(readFileSync(join(bundle, String(worker)), "utf8")).not.toContain("client-bedrock-runtime");
}, 130000);

// #5991 review: the Node session worker is one bundle (no splitting), so a Bun-only module reached through a lazy import
// is inlined, and a static `import ... from "bun:..."` in it makes Node refuse to load the worker
// (ERR_UNSUPPORTED_ESM_URL_SCHEME, before any of its code runs). Bun-only built-ins may only be imported dynamically.
test("loads the Node session worker bundle under Node without a module loader error", () => {
	// Given: freshly built workspace output and the production Node bundle builder.
	const bundle = join(repo, "packages/coding-agent/dist/bundle");
	// When
	const result = spawnSync("node", ["scripts/build-coding-agent-bundle.mjs"], {
		cwd: repo, encoding: "utf8", timeout: 120000,
	});
	// Then
	expect(result.status, result.stderr).toBe(0);
	const worker = readdirSync(bundle, { recursive: true }).find((path) => String(path).endsWith("session-worker.js"));
	if (worker === undefined) throw new Error("Node session worker bundle is absent");
	// Imported outside a worker thread, the module links and then refuses to run with no parent port: an error with no
	// loader code. A static Bun built-in import fails at link time instead, with the loader's ERR_ code. The verdict is
	// the exit code: the bundle routes console output to stderr.
	const probe = `import(${JSON.stringify(pathToFileURL(join(bundle, String(worker))).href)}).then(
		() => process.exit(0),
		(error) => {
			const loader = error instanceof SyntaxError || String(error?.code ?? "").startsWith("ERR_");
			process.stderr.write(\`\${error?.code} \${error?.message}\\n\`);
			process.exit(loader ? 3 : 0);
		},
	)`;
	const loaded = spawnSync("node", ["--input-type=module", "-e", probe], { cwd: repo, encoding: "utf8", timeout: 60000 });
	expect(loaded.status, loaded.stderr).toBe(0);
}, 130000);
