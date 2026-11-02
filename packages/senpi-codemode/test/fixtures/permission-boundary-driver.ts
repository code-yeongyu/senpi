import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";
import { createIdentityDecider } from "./path-identity.ts";
import { capabilityCases, resourceCases } from "./permission-boundary-cases.ts";

const root = mkdtempSync(join(tmpdir(), "permission-boundaries-"));
const failures: string[] = [];
let passed = 0;
try {
	for (const mode of ["worker", "inline"]) {
		for (const active of [true, false]) {
			const p = join(root, "data");
			const q = join(root, "other");
			const addon = join(root, "addon.node");
			writeFileSync(p, "{}");
			writeFileSync(addon, "");
			const denied = new Set<string>();
			const kernel = new JavaScriptKernel({
				sessionId: crypto.randomUUID(),
				cwd: root,
				parallelPoolWidth: 2,
				...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(root, "missing.js")) } : {}),
				permissions: {
					checkDeadlineMs: 120_000,
					state: () => ({ active, epoch: 1, rules: [{ permission: "read", pattern: "boundary", layer: "user" }] }),
					// Design 6.6: the fixture decides by file identity, so a symlinked TMPDIR (CI runs this with
					// TMPDIR=/tmp on macOS) names the same denied file under every spelling.
					decide: createIdentityDecider(denied),
				},
			});
			const run = (code: string) => kernel.run({ cellId: crypto.randomUUID(), code, timeoutMs: 120_000 });
			const check = async (name: string, code: string, permissionRefusal: boolean) => {
				const result = await run(
					`const p=${JSON.stringify(p)},q=${JSON.stringify(q)},addon=${JSON.stringify(addon)}; const fs=require('node:fs'); ${code}`,
				);
				try {
					assert.equal(
						!result.ok && result.error?.code === "cell_permission_denied",
						permissionRefusal,
						JSON.stringify(result),
					);
					if (permissionRefusal) {
						assert.equal(result.ok, false);
						assert.equal(result.error?.permissionRule?.pattern, "boundary");
					}
					passed++;
				} catch (error) {
					failures.push(`${mode}/${active}/${name}: ${String(error)}`);
				}
			};
			try {
				for (const [name, code] of capabilityCases) await check(name, code, active);
				for (const [name, code] of resourceCases) {
					rmSync(q, { force: true });
					await check(name, code, active);
					if (active && existsSync(q)) failures.push(`${mode}/${name}: created denied secondary file`);
				}
				await check("literal eval", "return eval('1+1')", false);
				await check("literal Function", "return new Function('return 1')()", false);
				for (const module of ["node:sqlite", "bun:sqlite"]) {
					for (const memory of [":memory:", ""]) {
						await check(
							`${module} memory`,
							`const S=require('${module}');const db=new (S.DatabaseSync??S.Database)(${JSON.stringify(memory)});try {return db.prepare("SELECT 'attach'").get()} finally {db.close()}`,
							false,
						);
					}
				}
				for (const side of ["source", "destination"]) {
					rmSync(q, { force: true });
					rmSync(p, { force: true });
					denied.clear();
					if (side === "destination") denied.add(q);
					// Source is opened before its decision becomes deny; backup must check it again.
					await check(
						`backup ${side} setup`,
						"globalThis.backupDb=new (require('node:sqlite').DatabaseSync)(p);backupDb.exec('CREATE TABLE t(x)')",
						false,
					);
					if (side === "source") denied.add(p);
					await check(
						`backup ${side}`,
						"try {await require('node:sqlite').backup(backupDb,q)} finally {backupDb.close()}",
						active,
					);
					if (active && existsSync(q)) failures.push(`${mode}/backup ${side}: created destination`);
				}
				denied.clear();
				const dependency = join(root, "secret.json");
				const outer = join(root, "outer.mjs");
				const text = join(root, "allowed.txt");
				writeFileSync(dependency, '{"secret":42}');
				writeFileSync(outer, "import data from './secret.json';export default data;");
				writeFileSync(text, "allowed text");
				denied.add(dependency);
				for (const specifier of ["./outer.mjs", outer, "./secret.json", dependency]) {
					for (let hit = 0; hit < 2; hit++)
						await check(
							`import ${specifier} cache ${hit}`,
							`return (await import(${JSON.stringify(specifier)})).default`,
							active,
						);
				}
				const attributed = await run("return (await import('./allowed.txt',{with:{type:'text'}})).default");
				try {
					assert.equal(attributed.ok, true, JSON.stringify(attributed));
					assert.equal(attributed.valueRepr, '"allowed text"', JSON.stringify(attributed));
					passed++;
				} catch (error) {
					failures.push(`${mode}/attributed: ${String(error)}`);
				}
				const pkg = join(root, "node_modules", "permission-native");
				mkdirSync(pkg, { recursive: true });
				writeFileSync(join(pkg, "package.json"), '{"name":"permission-native","type":"module","main":"index.js"}');
				writeFileSync(
					join(pkg, "index.js"),
					"import {appendFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';import Database from 'bun:sqlite';export const put=p=>appendFileSync(p,'bad');export const spawn=p=>spawnSync(p);export const database=p=>new Database(p);",
				);
				denied.clear();
				denied.add(q);
				rmSync(q, { force: true });
				await check("native dependency write", "const lib=await import('permission-native');lib.put(q)", active);
				assert.equal(existsSync(q), !active);
				const marker = join(root, "native-spawn-effect");
				rmSync(marker, { force: true });
				writeFileSync(q, `#!/bin/sh\nprintf ran > '${marker}'\n`);
				chmodSync(q, 0o755);
				await check("native dependency spawn", "const lib=await import('permission-native');lib.spawn(q)", active);
				assert.equal(existsSync(marker), !active);
				rmSync(q, { force: true });
				await check(
					"native dependency database",
					"const lib=await import('permission-native');lib.database(q).close()",
					active,
				);
				assert.equal(existsSync(q), !active);
			} finally {
				await kernel.close();
			}
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failures }));
process.exitCode = failures.length ? 1 : 0;
