// senpi#4527: run under Bun. Every export cell ownership patches is read through import() and through the CJS object in
// a real kernel cell; Bun fixes a built-in's ESM namespace at its first import, so an earlier kernel import would differ.
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

const exports: Record<string, string[]> = {
	"node:fs/promises": ["readFile", "writeFile", "open"],
	"node:fs": ["readFile", "writeFile", "createReadStream"],
	"node:timers": ["setTimeout", "setInterval"],
	"node:timers/promises": ["setTimeout"],
	"node:net": ["createConnection", "createServer"],
	"node:worker_threads": ["Worker"],
	"node:http": ["createServer", "request"],
	"node:dgram": ["createSocket"],
};
const kernel = new JavaScriptKernel({ cwd: process.cwd(), sessionId: crypto.randomUUID(), parallelPoolWidth: 1 });
try {
	const result = await kernel.run({
		cellId: "namespace",
		timeoutMs: 10_000,
		code: `const differ = []; for (const [name, keys] of Object.entries(${JSON.stringify(exports)})) {
			const namespace = await import(name); const live = process.getBuiltinModule(name);
			for (const key of keys) if (namespace[key] !== live[key]) differ.push(name + "." + key);
		} return differ;`,
	});
	console.log(
		JSON.stringify({ ok: result.ok, differ: result.ok ? JSON.parse(result.valueRepr ?? "null") : result.error }),
	);
} finally {
	await kernel.close();
}
