import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";

const operations = [
	{ name: "writeSync", tool: "write", body: "fs.writeFileSync(path,'effect')" },
	{ name: "writeAsync", tool: "write", body: "await fs.promises.writeFile(path,'effect')" },
	{
		name: "spawnSync",
		tool: "bash",
		body: "const r=cp.spawnSync(command);if(r.status!==0)throw Error('child failed')",
	},
	{
		name: "spawnAsync",
		tool: "bash",
		body: "await new Promise((resolve,reject)=>{const c=cp.spawn(command);c.once('error',reject);c.once('close',n=>n===0?resolve():reject(Error('child failed')))})",
	},
] as const;
const root = mkdtempSync(join(tmpdir(), "permission-native-loader-"));
const failures: string[] = [];
let passed = 0;
try {
	for (const mode of ["worker", "inline"]) {
		for (const route of ["plugin", "eval"]) {
			for (const active of [true, false]) {
				const dir = mkdtempSync(join(root, "kernel-"));
				const deniedPath = join(dir, "denied-write");
				const deniedCommand = join(dir, "denied-command");
				const allowedPath = join(dir, "allowed-write");
				const allowedCommand = join(dir, "allowed-command");
				const marker = join(dir, "spawn-effect");
				for (const command of [deniedCommand, allowedCommand]) {
					writeFileSync(command, `#!/bin/sh\nprintf effect > '${marker}'\n`);
					chmodSync(command, 0o755);
				}
				const pkg = join(dir, "node_modules", "permission-native-loader");
				mkdirSync(pkg, { recursive: true });
				writeFileSync(join(pkg, "package.json"), '{"type":"module","main":"index.js"}');
				const dispatch = operations.map((op) => `case '${op.name}': {${op.body};break;}`).join("");
				const body = `switch(operation){${dispatch}}return '${route}';`;
				const source = `import fs from 'node:fs';import cp from 'node:child_process';export async function run(operation,path,command){${body}}`;
				const generated = join(pkg, "generated.permission.js");
				writeFileSync(generated, "throw Error('onLoad was not reached');");
				writeFileSync(
					join(pkg, "index.js"),
					route === "plugin"
						? `Bun.plugin({name:'permission-native-loader',setup(b){b.onLoad({filter:/generated\\.permission\\.js$/},()=>({contents:${JSON.stringify(source)},loader:'js'}))}});
export async function run(...args){return (await import(${JSON.stringify(generated)})).run(...args)}`
						: `import fs from 'node:fs';import cp from 'node:child_process';
export async function run(...args){const pieces=['(async function(operation,path,command){',${JSON.stringify(body)},'})'];return eval(pieces.join(''))(...args)}`,
				);
				const calls: string[] = [];
				const writeRule = { permission: "edit", pattern: deniedPath, layer: "user" } as const;
				const spawnRule = { permission: "bash", pattern: deniedCommand, layer: "user" } as const;
				const kernel = new JavaScriptKernel({
					sessionId: crypto.randomUUID(),
					cwd: dir,
					parallelPoolWidth: 2,
					...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(dir, "missing.js")) } : {}),
					permissions: {
						checkDeadlineMs: 120_000,
						state: () => ({ active, epoch: 1, rules: [writeRule, spawnRule] }),
						decide: (_token, call) => {
							calls.push(call.tool);
							if (call.tool === "write" && call.input.path === deniedPath)
								return { action: "deny", rule: writeRule };
							if (call.tool === "bash" && call.input.command?.includes(deniedCommand))
								return { action: "deny", rule: spawnRule };
							return { action: "pass" };
						},
					},
				});
				try {
					for (const operation of operations) {
						for (const denied of active ? [true, false] : [true]) {
							const path = denied ? deniedPath : allowedPath;
							const command = denied ? deniedCommand : allowedCommand;
							rmSync(path, { force: true });
							rmSync(marker, { force: true });
							calls.length = 0;
							const result = await kernel.run({
								cellId: crypto.randomUUID(),
								code: `const lib=await import('permission-native-loader');return await lib.run(${JSON.stringify(operation.name)},${JSON.stringify(path)},${JSON.stringify(command)})`,
								timeoutMs: 120_000,
							});
							try {
								assert.equal(kernel.mode, mode);
								if (active && denied) {
									assert.equal(result.ok, false, JSON.stringify(result));
									if (result.ok) throw Error("denied operation succeeded");
									assert.equal(result.error?.code, "cell_permission_denied", JSON.stringify(result));
									assert.deepEqual(
										result.error?.permissionRule,
										operation.tool === "write" ? writeRule : spawnRule,
									);
									assert.equal(existsSync(path), false, "denied write effect");
									assert.equal(existsSync(marker), false, "denied spawn effect");
								} else {
									assert.equal(result.ok, true, JSON.stringify(result));
									if (!result.ok) throw Error("control failed");
									assert.equal(result.valueRepr, JSON.stringify(route));
									assert.equal(existsSync(operation.tool === "write" ? path : marker), true);
								}
								if (active) assert.ok(calls.includes(operation.tool), "operation never reached authorization");
								else assert.equal(calls.length, 0);
								passed++;
							} catch (error) {
								failures.push(
									`${mode}/${route}/${active ? (denied ? "deny" : "allow") : "inactive"}/${operation.name}: ${String(error)}`,
								);
							}
						}
					}
				} finally {
					await kernel.close();
				}
			}
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failures }));
process.exitCode = failures.length ? 1 : 0;
