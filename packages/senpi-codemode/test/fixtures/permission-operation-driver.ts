import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";
import { blobControls, bunOperations } from "./permission-operation-bun.ts";
import { fsOperations } from "./permission-operation-fs.ts";
import { processOperations } from "./permission-operation-process.ts";
import { sinkControls, sinkOperations } from "./permission-operation-sinks.ts";

const root = mkdtempSync(join(tmpdir(), "permission-operations-"));
const failures: string[] = [];
let passed = 0;
let uploads = 0;
const server = createServer(async (request, response) => {
	uploads++;
	for await (const chunk of request) response.write(chunk);
	response.end();
});
await new Promise<void>((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address === "object");
const endpoint = `http://127.0.0.1:${address.port}/`;
function snapshot(path: string): unknown {
	if (!existsSync(path)) return null;
	const stat = lstatSync(path);
	return stat.isDirectory()
		? readdirSync(path)
				.sort()
				.map((name) => [name, snapshot(join(path, name))])
		: [
				stat.mode,
				stat.uid,
				stat.gid,
				stat.mtimeMs,
				stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path).toString("base64"),
			];
}
try {
	for (const mode of ["worker", "inline"]) {
		for (const active of [true, false]) {
			const denied = new Set<string>();
			let readOnlyDeny = false;
			const seen: { tool: string; path?: string }[] = [];
			const kernel = new JavaScriptKernel({
				sessionId: crypto.randomUUID(),
				cwd: root,
				parallelPoolWidth: 2,
				...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(root, "absent.js")) } : {}),
				permissions: {
					checkDeadlineMs: 120_000,
					state: () => ({ epoch: 1, active, rules: [{ permission: "read", pattern: "target", layer: "user" }] }),
					decide: (_token, call) => {
						seen.push({ tool: call.tool, ...(call.input.path ? { path: call.input.path } : {}) });
						return (!readOnlyDeny || ["read"].includes(call.tool)) &&
							[...denied].some((p) => call.input.path === p || call.input.command?.includes(p))
							? { action: "deny", rule: { permission: call.tool, pattern: "target", layer: "user" } }
							: { action: "pass" };
					},
				},
			});
			try {
				for (const row of [...fsOperations, ...processOperations, ...bunOperations, ...sinkOperations]) {
					for (const deny of active ? [true, false] : [false]) {
						const dir = mkdtempSync(join(root, "row-"));
						const p = join(dir, row.seed === "module" ? "target.cjs" : "target");
						const q = join(dir, "source");
						writeFileSync(q, "{}");
						switch (row.seed) {
							case "missing":
								break;
							case "directory":
								mkdirSync(p);
								break;
							case "link":
								symlinkSync(q, p);
								break;
							case "database":
								writeFileSync(p, "");
								break;
							case "module":
								writeFileSync(
									p,
									`require('node:fs').writeFileSync(${JSON.stringify(join(dir, "effect"))},'ok');`,
								);
								break;
							case "executable":
								writeFileSync(p, `#!/bin/sh\nprintf ok > '${join(dir, "effect")}'\nprintf ok\n`);
								chmodSync(p, 0o755);
								break;
							default:
								writeFileSync(p, "{}");
						}
						denied.clear();
						if (deny) denied.add(p);
						seen.length = 0;
						const before = snapshot(dir);
						const uploadsBefore = uploads;
						const code = `const p=${JSON.stringify(p)},q=${JSON.stringify(q)},endpoint=${JSON.stringify(endpoint)}; const fs=require('node:fs'),cp=require('node:child_process');
							${row.code}
							return Array.isArray(result)?'array':Buffer.isBuffer(result)?'buffer':result instanceof Uint8Array?'uint8array':result instanceof ArrayBuffer?'arraybuffer':typeof result;`;
						const result = await kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 120_000 });
						try {
							if (deny) {
								assert.equal(result.ok, false, JSON.stringify(result));
								assert.equal(result.error?.code, "cell_permission_denied", JSON.stringify(result));
								assert.equal(result.error?.permissionRule?.pattern, "target");
								assert.deepEqual(snapshot(dir), before, "denied operation changed filesystem");
								assert.equal(uploads, uploadsBefore, "denied file reached the HTTP server");
							} else {
								assert.equal(result.ok, true, JSON.stringify(result));
								assert.equal(result.valueRepr, JSON.stringify(row.shape));
							}
							if (active)
								assert.ok(
									seen.some((call) => call.tool === row.tool),
									`missing ${row.tool} decision`,
								);
							else assert.equal(seen.length, 0);
							assert.equal(kernel.mode, mode);
							passed++;
						} catch (error) {
							failures.push(
								`${mode}/${active ? (deny ? "deny" : "allow") : "inactive"}/${row.api}: ${String(error)}`,
							);
						}
						rmSync(dir, { recursive: true, force: true });
					}
				}
				readOnlyDeny = true;
				for (const row of [...blobControls, ...sinkControls]) {
					const p = join(root, "read-denied");
					const q = join(root, "memory-output");
					writeFileSync(p, "{}");
					denied.clear();
					denied.add(p);
					const result = await kernel.run({
						cellId: crypto.randomUUID(),
						code: `const p=${JSON.stringify(p)},q=${JSON.stringify(q)};const fs=require('node:fs');${row.code}`,
						timeoutMs: 120_000,
					});
					try {
						assert.equal(result.ok, true, JSON.stringify(result));
						assert.equal(result.valueRepr, JSON.stringify(row.expected));
						passed++;
					} catch (error) {
						failures.push(`${mode}/${active ? "active" : "inactive"}/${row.api}: ${String(error)}`);
					}
				}
			} finally {
				await kernel.close();
			}
		}
	}
} finally {
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failures }));
process.exitCode = failures.length ? 1 : 0;
