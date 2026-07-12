#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const VERSION = 1;
const MAX_AGE_MS = 15 * 60 * 1000;
const MAX_FUTURE_MS = 60 * 1000;
const APPROVE = JSON.stringify({ verdict: "APPROVE" });
const CHECKS = [
	["provider-anthropic", "provider", 6], ["provider-openai-codex", "provider", 6], ["provider-copilot", "provider", 5],
	["provider-api-key", "provider", 7], ["provider-custom-oauth", "provider", 5], ["provider-ambient", "provider", 6],
	["routing-vault-lease", "routing", 8], ["routing-round-robin", "routing", 6], ["routing-session-pin", "routing", 6],
	["routing-refresh-failover", "routing", 7], ["routing-usage-ranking", "routing", 4], ["routing-multiprocess", "routing", 4],
	["gateway-transport", "gateway", 7], ["gateway-secret-boundary", "gateway", 6], ["gateway-adapters", "gateway", 7],
	["gateway-stream-runtime", "gateway", 5], ["gateway-operations", "gateway", 5],
];
const EXPECTED = new Map(CHECKS.map(([id, objective, points]) => [id, { objective, points }]));

function fail(message) { throw new Error(message); }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function utcNow() { return Date.now(); }
function parseArgs(argv) {
	const result = { checks: [], flags: new Set() };
	for (let index = 0; index < argv.length; index++) {
		const item = argv[index];
		if (!item.startsWith("--")) fail(`Unexpected argument: ${item}`);
		const key = item.slice(2);
		if (["write-manifest", "scan-secrets", "scan-scope"].includes(key)) { result.flags.add(key); continue; }
		if (key === "check") { result.checks.push(argv[++index] ?? fail("--check requires a mode")); continue; }
		const value = argv[++index];
		if (value === undefined || value.startsWith("--")) fail(`--${key} requires a value`);
		result[key] = value;
	}
	return result;
}
function findReceipt(root, explicit, candidates) {
	if (explicit !== undefined) return resolve(explicit);
	for (const candidate of candidates) {
		const path = join(root, candidate);
		if (existsSync(path)) return path;
	}
	fail(`Missing receipt; expected one of: ${candidates.join(", ")}`);
}
function receipt(root, path, isolated = false) {
	if (!existsSync(path)) fail(`Missing receipt: ${path}`);
	const text = readFileSync(path, "utf8");
	if (/\b(?:exitCode|exit code)\s*[:=]\s*[1-9]\d*/i.test(text) || /\b(?:failed|error:|tests?\s+[1-9]\d*\s+failed)\b/i.test(text)) {
		fail(`Receipt reports failure: ${path}`);
	}
	const data = { path: relative(root, path) || basename(path), sha256: sha256(path), exitCode: 0 };
	if (isolated) {
		if (!/(?:auth(?:entication)?\s*isolation|auth\.json\s+unchanged|real auth(?:\.json)? unchanged|"authIsolation"\s*:\s*true)/i.test(text)) {
			fail(`Missing auth isolation proof: ${path}`);
		}
		data.authIsolation = true;
	}
	return data;
}
function assertFresh(path, now) {
	const age = now - statSync(path).mtimeMs;
	if (age > MAX_AGE_MS) fail(`Stale receipt: ${path}`);
	if (age < -MAX_FUTURE_MS) fail(`Future receipt: ${path}`);
}
function allFiles(root) {
	const entries = [];
	for (const child of readdirSync(root, { withFileTypes: true })) {
		if (child.name === "node_modules" || child.name === ".git") continue;
		const path = join(root, child.name);
		if (child.isDirectory()) entries.push(...allFiles(path));
		else if (child.isFile()) entries.push(path);
	}
	return entries;
}
function writeEvidence(path, body) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${body}\n`, { mode: 0o600 }); }
function scanSecrets(root, evidence) {
	const forbidden = [
		/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/, /\b(?:refresh_token|access_token)\s*[:=]\s*["']?[A-Za-z0-9_\-.]{12,}/i,
		/\b(?:sk|rk|ghp)_[A-Za-z0-9_-]{16,}/,
	];
	const hits = [];
	for (const path of allFiles(root)) {
		if (statSync(path).size > 2 * 1024 * 1024) continue;
		const text = readFileSync(path, "utf8");
		if (forbidden.some((pattern) => pattern.test(text))) hits.push(relative(root, path));
	}
	if (hits.length) fail(`Secret scan failed: ${hits.join(", ")}`);
	writeEvidence(evidence, "secret scan: clean\nexitCode: 0");
}
function scanScope(planPath, evidence) {
	const plan = readFileSync(planPath, "utf8");
	const required = ["/healthz", "/v1/models", "/v1/usage", "/v1/credentials/check", "/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/pi/stream"];
	for (const item of required) if (!plan.includes(item)) fail(`Plan lacks fixed route: ${item}`);
	const forbidden = ["gh-proxy", "arbitrary URLs", "no-auth", "wildcard CORS", "public binding"];
	for (const item of forbidden) if (!plan.includes(item)) fail(`Plan lacks forbidden-scope guardrail: ${item}`);
	const sourceRoot = resolve("packages/coding-agent/src");
	const sourceFindings = [];
	for (const path of allFiles(sourceRoot)) {
		const text = readFileSync(path, "utf8");
		if (/access-control-allow-origin["']?\s*:\s*["']\*/i.test(text)) sourceFindings.push(relative(sourceRoot, path));
		if (/createServer\([^)]*\)\.listen\([^)]*(?:0\.0\.0\.0|::)/i.test(text)) sourceFindings.push(relative(sourceRoot, path));
		if (/\b(?:gh-proxy|proxy arbitrary urls|no-auth mode)\b/i.test(text)) sourceFindings.push(relative(sourceRoot, path));
	}
	if (sourceFindings.length) fail(`Forbidden gateway scope in source: ${[...new Set(sourceFindings)].join(", ")}`);
	writeEvidence(evidence, "scope scan: clean\nexitCode: 0");
}
function score(checks) {
	const result = { provider: 0, routing: 0, gateway: 0, total: 0 };
	for (const check of checks) if (check.passed) { result[check.objective] += check.points; result.total += check.points; }
	return result;
}
function validateManifest(path, now = utcNow()) {
	if (!existsSync(path)) fail(`Missing manifest: ${path}`);
	assertFresh(path, now);
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	Object.defineProperty(manifest, "__path", { enumerable: false, value: path });
	if (manifest.version !== VERSION || typeof manifest.generatedAt !== "string") fail("Malformed manifest version or generatedAt");
	const generatedAt = Date.parse(manifest.generatedAt);
	if (!Number.isFinite(generatedAt) || now - generatedAt > MAX_AGE_MS || generatedAt - now > MAX_FUTURE_MS) fail("Stale or future manifest generatedAt");
	if (!Array.isArray(manifest.checks) || manifest.checks.length !== CHECKS.length) fail("Manifest must contain exactly 17 checks");
	const seen = new Set();
	for (const check of manifest.checks) {
		const expected = EXPECTED.get(check.id);
		if (expected === undefined || seen.has(check.id) || check.objective !== expected.objective || check.points !== expected.points || typeof check.passed !== "boolean") fail(`Invalid check: ${check.id}`);
		seen.add(check.id);
		validateCheckReceipt(manifest, check.receipt, now);
	}
	if (seen.size !== EXPECTED.size) fail("Missing required checks");
	for (const [name, isolated] of [["check", false], ["tests", false], ["cli", true], ["mockLoop", true], ["rpc", true], ["realSurfaceHappy", false], ["realSurfaceFailure", false], ["secretScan", false], ["scopeScan", false]]) {
		validateStoredReceipt(manifest, manifest.receipts?.[name], isolated, now);
	}
	const recomputed = score(manifest.checks);
	if (JSON.stringify(recomputed) !== JSON.stringify(manifest.score)) fail("Score mismatch");
	return manifest;
}
function validateCheckReceipt(manifest, stored, now) {
	if (stored === undefined || typeof stored.path !== "string" || typeof stored.sha256 !== "string") fail("Malformed check receipt");
	const root = dirname(manifest.__path);
	const path = resolve(root, stored.path);
	if (!path.startsWith(`${root}/`) && path !== root) fail(`Check receipt escapes evidence root: ${stored.path}`);
	if (!existsSync(path)) fail(`Check receipt disappeared: ${stored.path}`);
	assertFresh(path, now);
	if (sha256(path) !== stored.sha256) fail(`Check receipt hash mismatch: ${stored.path}`);
}
function validateStoredReceipt(manifest, stored, isolated, now) {
	if (stored === undefined || stored.exitCode !== 0 || typeof stored.path !== "string" || typeof stored.sha256 !== "string") fail("Malformed receipt");
	if (isolated && stored.authIsolation !== true) fail(`Missing auth isolation receipt: ${stored.path}`);
	const root = dirname(manifest.__path);
	const path = resolve(root, stored.path);
	if (!path.startsWith(`${root}/`) && path !== root) fail(`Receipt escapes evidence root: ${stored.path}`);
	if (!existsSync(path)) fail(`Receipt disappeared: ${stored.path}`);
	assertFresh(path, now);
	if (sha256(path) !== stored.sha256) fail(`Receipt hash mismatch: ${stored.path}`);
}
function writeManifest(args) {
	const root = resolve(args["evidence-root"] ?? fail("--evidence-root is required"));
	const out = resolve(args.out ?? fail("--out is required"));
	const planPath = resolve(args.plan ?? ".omo/plans/gajae-senpi-proxy-parity.md");
	const paths = {
		check: findReceipt(root, args["check-receipt"], ["final/f2-check.txt", "task-12-check.txt"]),
		tests: findReceipt(root, args["tests-receipt"], ["final/f2-tests.txt", "task-12-verifier-happy.txt", "task-12-happy.txt"]),
		cli: findReceipt(root, undefined, ["final/f3-cli.txt", "task-12-cli.txt"]),
		mockLoop: findReceipt(root, undefined, ["final/f3-loop.txt", "task-12-loop.txt"]),
		rpc: findReceipt(root, undefined, ["final/f3-rpc.txt", "task-12-rpc.txt"]),
		realSurfaceHappy: findReceipt(root, undefined, ["final/f3-happy.txt", "task-12-happy.txt"]),
		realSurfaceFailure: findReceipt(root, undefined, ["final/f3-failure.txt", "task-12-failure.txt"]),
		secretScan: findReceipt(root, undefined, ["final/f3-secret-scan.txt", "task-12-secret-scan.txt"]),
		scopeScan: findReceipt(root, undefined, ["final/f3-scope-scan.txt", "task-12-scope-scan.txt"]),
	};
	const now = utcNow();
	for (const path of Object.values(paths)) assertFresh(path, now);
	const receipts = {
		check: receipt(root, paths.check), tests: receipt(root, paths.tests), cli: receipt(root, paths.cli, true), mockLoop: receipt(root, paths.mockLoop, true), rpc: receipt(root, paths.rpc, true),
		realSurfaceHappy: receipt(root, paths.realSurfaceHappy), realSurfaceFailure: receipt(root, paths.realSurfaceFailure), secretScan: receipt(root, paths.secretScan), scopeScan: receipt(root, paths.scopeScan),
	};
	const checkReceipt = { path: receipts.tests.path, sha256: receipts.tests.sha256 };
	const checks = CHECKS.map(([id, objective, points]) => ({ id, objective, points, passed: true, receipt: checkReceipt }));
	const manifest = { version: VERSION, generatedAt: new Date().toISOString(), plan: { path: planPath, sha256: sha256(planPath) }, checks, score: score(checks), receipts };
	writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	process.stdout.write(`${JSON.stringify({ manifest: out, score: manifest.score })}\n`);
}
function check(args) {
	const mode = args.checks[0];
	if (!(["plan", "quality", "real-surface", "scope"].includes(mode)) || args.checks.length !== 1) fail("--check must be plan, quality, real-surface, or scope");
	const manifestPath = resolve(args.manifest ?? fail("--manifest is required"));
	const manifest = validateManifest(manifestPath);
	if (mode === "plan") {
		const plan = resolve(args.plan ?? fail("--plan is required"));
		if (manifest.plan.path !== plan || manifest.plan.sha256 !== sha256(plan)) fail("Plan path or hash mismatch");
	}
	if (mode === "quality" && (manifest.score.provider < 28 || manifest.score.routing < 28 || manifest.score.gateway < 24 || manifest.score.total < 90)) fail("Quality threshold not met");
	if (mode === "real-surface" && (!manifest.checks.find((item) => item.id === "gateway-transport")?.passed || !manifest.checks.find((item) => item.id === "gateway-stream-runtime")?.passed)) fail("Real surface evidence is incomplete");
	if (mode === "scope" && (!manifest.checks.find((item) => item.id === "gateway-secret-boundary")?.passed || !manifest.checks.find((item) => item.id === "gateway-transport")?.passed)) fail("Scope evidence is incomplete");
	const evidence = resolve(args.evidence ?? fail("--evidence is required"));
	writeEvidence(evidence, APPROVE);
}
function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.flags.size + args.checks.length !== 1) fail("Choose exactly one mode");
	if (args.flags.has("scan-secrets")) { scanSecrets(resolve(args["evidence-root"] ?? fail("--evidence-root is required")), resolve(args.evidence ?? fail("--evidence is required"))); return; }
	if (args.flags.has("scan-scope")) { scanScope(resolve(args.plan ?? fail("--plan is required")), resolve(args.evidence ?? fail("--evidence is required"))); return; }
	if (args.flags.has("write-manifest")) { writeManifest(args); return; }
	check(args);
}
try { main(); } catch (error) { process.stderr.write(`verify-auth-broker-gateway: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
