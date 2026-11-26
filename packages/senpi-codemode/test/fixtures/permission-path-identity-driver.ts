import assert from "node:assert/strict";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JavaScriptKernel } from "../../src/kernels/js/context-manager.ts";
import { createIdentityDecider, type RecordedCall } from "./path-identity.ts";

// Design 11.2: every row names ONE file (the secret) through two spellings, the rule's and the
// request's, and asserts that an active deny refuses the operation (no effect), that an inactive
// kernel passes it (parity), and that the decider received the written path plus the executed path.
const root = mkdtempSync(join(tmpdir(), "permission-path-identity-"));
const real = realpathSync.native(root);
const darwin = process.platform === "darwin";
const failures: string[] = [];
let passed = 0;

function sameEntry(a: string, b: string): boolean {
	try {
		const x = lstatSync(a, { bigint: true });
		const y = lstatSync(b, { bigint: true });
		return x.dev === y.dev && x.ino === y.ino;
	} catch {
		return false;
	}
}

const secret = join(root, "real", "secret");
const secretReal = join(real, "real", "secret");
mkdirSync(join(root, "real"), { recursive: true });
writeFileSync(secret, "SECRET");
writeFileSync(join(root, "real", "allowed"), "ALLOWED");
symlinkSync(join(root, "real"), join(root, "link"));
symlinkSync(secret, join(root, "flink"));
symlinkSync(join(root, "real", "missing"), join(root, "dangle"));
symlinkSync(join(root, "real", "gone", "missing"), join(root, "dangle2"));
const caseAlias = join(root, "REAL", "secret");
const foldsCase = sameEntry(caseAlias, secret);
let tmpAlias: string | undefined;
if (darwin) {
	tmpAlias = mkdtempSync(`/tmp/permission-path-identity-${process.pid}-`);
	writeFileSync(join(tmpAlias, "secret"), "SECRET");
}
const nfcFile = darwin ? join(root, "real", "caf\u00e9.txt") : undefined;
const nfdFile = darwin ? join(root, "real", "cafe\u0301.txt") : undefined;
if (nfcFile) writeFileSync(nfcFile, "SECRET");

type Pair = { readonly name: string; readonly rule: string; readonly request: string };

const pairs: Pair[] = [
	{ name: "real x link", rule: secretReal, request: join(root, "link", "secret") },
	{ name: "link x real", rule: join(root, "link", "secret"), request: secretReal },
	{ name: "link x flink", rule: join(root, "link", "secret"), request: join(root, "flink") },
	{ name: "flink x real", rule: join(root, "flink"), request: secretReal },
	{ name: "real x relative link", rule: secretReal, request: "link/secret" },
	{ name: "real x link/../secret", rule: secretReal, request: "link/../real/secret" },
	{ name: "real x file URL via link", rule: secretReal, request: pathToFileURL(join(root, "link", "secret")).href },
	{ name: "glob prefix via link x real", rule: `${join(root, "link")}/*`, request: secretReal },
	...(foldsCase
		? [
				{ name: "case alias x real", rule: caseAlias, request: secretReal },
				{ name: "real x case alias", rule: secretReal, request: caseAlias },
			]
		: []),
	...(tmpAlias
		? [
				{
					name: "/tmp alias x /private/tmp",
					rule: join(tmpAlias, "secret"),
					request: `/private${join(tmpAlias, "secret")}`,
				},
				{
					name: "/private/tmp x /tmp alias",
					rule: `/private${join(tmpAlias, "secret")}`,
					request: join(tmpAlias, "secret"),
				},
			]
		: []),
	...(nfcFile && nfdFile
		? [
				{ name: "NFC x NFD", rule: nfcFile, request: nfdFile },
				{ name: "NFD x NFC", rule: nfdFile, request: nfcFile },
			]
		: []),
];

const requestExpr = (request: string) =>
	request.startsWith("file:") ? `new URL(${JSON.stringify(request)})` : JSON.stringify(request);

/** Read operations on the request spelling; every one must be refused under an active deny. */
const readOps: [string, (request: string) => string][] = [
	["readFileSync", (q) => `return fs.readFileSync(${requestExpr(q)}, 'utf8')`],
	["openSync r", (q) => `const fd = fs.openSync(${requestExpr(q)}, 'r'); fs.closeSync(fd); return 'opened'`],
	[
		"createReadStream",
		(q) =>
			`const s = fs.createReadStream(${requestExpr(q)}); await new Promise((ok, no) => { s.on('error', no); s.on('data', () => {}); s.on('end', ok); }); return 'streamed'`,
	],
	["promises.readFile", (q) => `return await fs.promises.readFile(${requestExpr(q)}, 'utf8')`],
	["Bun.file text", (q) => `return await Bun.file(${requestExpr(q)}).text()`],
	[
		"import dynamic",
		(q) =>
			`return (await import(${q.startsWith("/") || q.startsWith("file:") ? requestExpr(q) : JSON.stringify(`./${q}`)}, { with: { type: 'text' } })).default`,
	],
];

const writeOps: [string, (request: string) => string][] = [
	["writeFileSync", (q) => `fs.writeFileSync(${requestExpr(q)}, 'CHANGED'); return 'wrote'`],
	[
		"openSync w",
		(q) =>
			`const fd = fs.openSync(${requestExpr(q)}, 'w'); fs.writeSync(fd, 'CHANGED'); fs.closeSync(fd); return 'wrote'`,
	],
	[
		"createWriteStream",
		(q) =>
			`const s = fs.createWriteStream(${requestExpr(q)}); await new Promise((ok, no) => { s.on('error', no); s.end('CHANGED', ok); }); return 'wrote'`,
	],
	["Bun.write", (q) => `await Bun.write(${requestExpr(q)}, 'CHANGED'); return 'wrote'`],
];

try {
	for (const mode of ["worker", "inline"]) {
		for (const active of [true, false]) {
			const denied = new Set<string>();
			const calls: RecordedCall[] = [];
			const decide = createIdentityDecider(denied, calls);
			const kernel = new JavaScriptKernel({
				sessionId: crypto.randomUUID(),
				cwd: root,
				parallelPoolWidth: 2,
				...(mode === "inline" ? { workerEntryUrl: pathToFileURL(join(root, "missing.js")) } : {}),
				permissions: {
					checkDeadlineMs: 120_000,
					state: () => ({ active, epoch: 1, rules: [{ permission: "read", pattern: "boundary", layer: "user" }] }),
					decide,
				},
			});
			const run = (code: string) =>
				kernel.run({
					cellId: crypto.randomUUID(),
					code: `const fs = require('node:fs'); ${code}`,
					timeoutMs: 120_000,
				});
			const check = async (name: string, code: string, refused: boolean, after?: () => void) => {
				const result = await run(code);
				try {
					assert.equal(
						!result.ok && result.error?.code === "cell_permission_denied",
						refused,
						JSON.stringify(result),
					);
					if (refused)
						assert.equal(!result.ok && result.error?.permissionRule?.pattern === "boundary", true, "rule");
					after?.();
					passed++;
				} catch (error) {
					failures.push(`${mode}/${active}/${name}: ${String(error)}`);
				}
			};
			try {
				for (const pair of pairs) {
					denied.clear();
					denied.add(pair.rule);
					calls.length = 0;
					for (const [op, code] of readOps) {
						if (op === "import dynamic" && pair.request.includes("..")) continue;
						await check(`${pair.name} / ${op}`, code(pair.request), active);
					}
					const written = pair.request.startsWith("file:") ? new URL(pair.request).pathname : pair.request;
					const executed = pair.request.startsWith("file:") ? written : resolve(root, pair.request);
					if (active) {
						const seen = calls.find((call) => call.path === decodeURIComponent(written));
						try {
							assert.ok(seen, `decider never received the written spelling: ${JSON.stringify(calls.slice(-3))}`);
							assert.equal(seen?.executedPath, executed, "executed spelling");
							assert.ok(seen?.canonical || seen?.unresolvable, "canonical or unresolvable present");
							passed++;
						} catch (error) {
							failures.push(`${mode}/${active}/${pair.name} wire: ${String(error)}`);
						}
					}
					for (const [op, code] of writeOps) {
						if (pair.rule.includes("*")) continue;
						const target = pair.request.startsWith("file:")
							? new URL(pair.request).pathname
							: resolve(root, pair.request);
						const content = () => readFileSync(target, "utf8");
						writeFileSync(target, "SECRET");
						await check(`${pair.name} / ${op}`, code(pair.request), active, () => {
							assert.equal(content(), active ? "SECRET" : "CHANGED", "effect");
						});
						writeFileSync(target, "SECRET");
					}
				}

				// Written-relative deny stays a deny by its written spelling (C1 control), and a bare name too.
				denied.clear();
				denied.add("link/secret");
				await check("written-relative deny (control)", "return fs.readFileSync('link/secret', 'utf8')", active);
				denied.clear();
				denied.add("secret");
				await check("bare-name deny on the written spelling", "return fs.readFileSync('secret', 'utf8')", active);

				// Module imports through an alias: relative, absolute, cache 0/1, and via an intermediate module.
				denied.clear();
				denied.add(secretReal);
				writeFileSync(join(root, "secret.json"), '{"secret":42}');
				denied.add(join(root, "secret.json"));
				writeFileSync(
					join(root, "outer.mjs"),
					"import data from './link/secret.json' with { type: 'json' };export default data;",
				);
				if (!existsSync(join(root, "real", "secret.json")))
					symlinkSync(join(root, "secret.json"), join(root, "real", "secret.json"));
				for (const specifier of [
					"./link/secret.json",
					join(root, "link", "secret.json"),
					pathToFileURL(join(root, "link", "secret.json")).href,
				]) {
					for (let hit = 0; hit < 2; hit++) {
						await check(
							`import ${specifier} cache ${hit}`,
							`return (await import(${JSON.stringify(specifier)})).default`,
							active,
						);
					}
				}
				await check("import via intermediate module", "return (await import('./outer.mjs')).default", active);

				// Dangling link: a write through it creates the link target, which is the decided canonical form.
				denied.clear();
				denied.add(join(real, "real", "missing"));
				rmSync(join(root, "real", "missing"), { force: true });
				await check(
					"write through a dangling link",
					"fs.writeFileSync('dangle', 'NEW'); return 'wrote'",
					active,
					() => {
						assert.equal(existsSync(join(root, "real", "missing")), !active, "effect");
					},
				);
				// A link whose target parent is missing is unresolvable: denied while a deny exists.
				await check(
					"write through a dangling link with a missing parent",
					"fs.writeFileSync('dangle2', 'NEW'); return 'wrote'",
					active,
				);
				if (active) {
					const seen = calls.find((call) => call.path === "dangle2");
					try {
						assert.equal(seen?.unresolvable, "EDANGLING");
						passed++;
					} catch (error) {
						failures.push(`${mode}/${active}/dangle2 wire: ${String(error)}`);
					}
				}

				// The relative `link/../x` spelling: the written path and the string the sink executes both travel.
				denied.clear();
				denied.add(secretReal);
				calls.length = 0;
				await run("try { fs.readFileSync('link/../real/secret', 'utf8') } catch {} return 1");
				if (active) {
					const seen = calls.find((call) => call.path === "link/../real/secret");
					try {
						assert.equal(seen?.executedPath, resolve(root, "link/../real/secret"));
						assert.ok(seen?.executedPath?.startsWith(root), "executed path anchored to the session cwd (N11)");
						passed++;
					} catch (error) {
						failures.push(`${mode}/${active}/link-dotdot wire: ${String(error)}`);
					}
				}

				// A user Worker started by the cell is decided the same way.
				if (mode === "worker") {
					writeFileSync(
						join(root, "worker-read.mjs"),
						"import { readFileSync } from 'node:fs'; postMessage(readFileSync('link/secret', 'utf8'));",
					);
					const viaWorker = await run(
						"const w = new Worker('./worker-read.mjs'); return await new Promise((ok) => { w.onmessage = (e) => ok('data:' + e.data); w.onerror = (e) => ok('error:' + (e.message ?? e.error?.message)); })",
					);
					try {
						assert.equal(viaWorker.ok, true, JSON.stringify(viaWorker));
						const value = (viaWorker.ok ? viaWorker.valueRepr : undefined) ?? "";
						if (active) assert.match(value, /^"error:.*Operation denied \(read: boundary, user\)/u, value);
						else assert.equal(value, '"data:SECRET"');
						passed++;
					} catch (error) {
						failures.push(`${mode}/${active}/user Worker reads through a link: ${String(error)}`);
					}
				}

				// Zero rules: nothing is computed and every operation passes with the same answers.
				denied.clear();
				calls.length = 0;
				await check("no rules: link read passes", "return fs.readFileSync('link/secret', 'utf8')", false);
				if (!active) assert.equal(calls.length, 0, "inactive kernel asked nothing");
			} finally {
				await kernel.close();
			}
		}
	}
} finally {
	rmSync(root, { recursive: true, force: true });
	if (tmpAlias) rmSync(tmpAlias, { recursive: true, force: true });
}
console.log(JSON.stringify({ passed, failures }));
process.exitCode = failures.length ? 1 : 0;
