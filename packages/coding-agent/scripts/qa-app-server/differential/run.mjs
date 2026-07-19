#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startFakeModelServer } from "../../../../../.agents/skills/senpi-qa/scripts/lib/fake-model-server.mjs";
import { runHandshake } from "../../../test/qa/app-server/differential/handshake.mjs";
import {
	CODEX_PORT,
	codexLaunch,
	createCell,
	FAKE_MODEL_PORT,
	SENPI_PORT,
	senpiLaunch,
} from "./cell.mjs";
import { assertClassifiedDiff, diffTranscripts, parseAllowlist } from "./diff.mjs";
import { normalizeTranscript } from "./normalize.mjs";
import { ORACLE_BINARY } from "./build-oracle.mjs";
import { ReadinessError, waitForHttpReady } from "./readiness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(here, "..", "..", "..");
const repoRoot = resolve(packageDir, "..", "..");
const evidenceDir = join(repoRoot, "local-ignore", "qa-evidence", "20260719-app-server-parity-task3");
const allowlistPath = join(here, "allowlist.json");
const qaPorts = [FAKE_MODEL_PORT, CODEX_PORT, SENPI_PORT];

class DifferentialHarnessError extends Error {
	name = "DifferentialHarnessError";
}

export async function runDifferential({ scenario = "handshake" } = {}) {
	if (scenario !== "handshake") throw new DifferentialHarnessError(`Unknown differential scenario: ${scenario}`);
	accessSync(ORACLE_BINARY, constants.X_OK);
	mkdirSync(evidenceDir, { recursive: true });

	const resources = { cell: undefined, fake: undefined, servers: [] };
	let failure;
	const cleanup = makeCleanup(resources);
	const signalHandler = async () => {
		try {
			await cleanup();
		} finally {
			process.exit(130);
		}
	};
	process.once("SIGINT", signalHandler);
	process.once("SIGTERM", signalHandler);

	try {
		resources.cell = createCell();
		resources.fake = await startFakeModelServer({ port: FAKE_MODEL_PORT, turns: [{ text: "unused" }] });
		if (resources.fake.port !== FAKE_MODEL_PORT) throw new DifferentialHarnessError("Fake model server bound an unexpected port.");

		resources.servers = [codexLaunch(resources.cell), senpiLaunch(resources.cell)].map(spawnServer);
		await Promise.all([
			waitForReady(resources.servers[0], CODEX_PORT),
			waitForReady(resources.servers[1], SENPI_PORT),
		]);
		const results = await runHandshake([
			{ target: "codex", url: `ws://127.0.0.1:${CODEX_PORT}`, token: resources.cell.token, port: CODEX_PORT },
			{ target: "senpi", url: `ws://127.0.0.1:${SENPI_PORT}`, token: resources.cell.token, port: SENPI_PORT },
		]);
		if (resources.fake.requests.length !== 0) {
			throw new DifferentialHarnessError("Handshake unexpectedly reached the model server.");
		}

		const oracle = normalizeTranscript(results[0].transcript, {
			tempPaths: [resources.cell.codexHome, resources.cell.dir],
			tokens: [resources.cell.token],
		});
		const candidate = normalizeTranscript(results[1].transcript, {
			tempPaths: [resources.cell.senpiAgentDir, resources.cell.dir],
			tokens: [resources.cell.token],
		});
		const allowlist = parseAllowlist(JSON.parse(readFileSync(allowlistPath, "utf8")));
		const diff = diffTranscripts({ scenario, oracle, candidate, allowlist });
		writeJsonl(join(evidenceDir, `${scenario}-codex.normalized.jsonl`), oracle);
		writeJsonl(join(evidenceDir, `${scenario}-senpi.normalized.jsonl`), candidate);
		writeFileSync(join(evidenceDir, `${scenario}-diff.json`), `${JSON.stringify(diff, null, 2)}\n`);
		assertClassifiedDiff(diff);
		for (const difference of diff.differences) {
			process.stdout.write(
				`DIFF=${difference.classification} RULE=${difference.ruleId ?? "automatic"} PATH=${difference.path}\n`,
			);
		}
		const blocking = diff.differences.filter(
			(difference) => difference.classification === "parity-regression" || difference.classification === "harness-defect",
		);
		if (blocking.length > 0) {
			throw new DifferentialHarnessError(`Differential run found ${blocking.length} blocking classified difference(s).`);
		}
		process.stdout.write("BAD_TOKEN_REJECTED=2 MISSING_TOKEN_REJECTED=2 HEALTH_OK=2 MALFORMED_BINARY_IGNORED=2\n");
		process.stdout.write(`SCENARIO=${scenario} RESULT=pass UNCLASSIFIED=${diff.unclassified.length}\n`);
	} catch (error) {
		failure = error;
	} finally {
		process.removeListener("SIGINT", signalHandler);
		process.removeListener("SIGTERM", signalHandler);
		try {
			await cleanup();
		} catch (error) {
			failure ??= error;
		}
		try {
			assertPortsEmpty();
		} catch (error) {
			failure ??= error;
		}
	}
	if (failure !== undefined) throw failure;
}

function spawnServer(spec) {
	const child = spawn(spec.command, spec.args, {
		cwd: spec.cwd,
		detached: process.platform !== "win32",
		env: spec.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const capture = (chunk) => {
		output = `${output}${chunk.toString("utf8")}`.slice(-12000);
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	const closed = new Promise((resolveClosed) => {
		child.once("error", (error) => resolveClosed({ error }));
		child.once("close", (code, signal) => resolveClosed({ code, signal }));
	});
	return { ...spec, child, closed, output: () => output };
}

async function waitForReady(server, port, timeoutMs = 30000) {
	try {
		await waitForHttpReady({ server, port, deadlineMs: timeoutMs });
	} catch (error) {
		if (!(error instanceof ReadinessError)) throw error;
		throw new DifferentialHarnessError(`${error instanceof Error ? error.message : String(error)}\n${sanitize(server.output())}`, {
			cause: error,
		});
	}
}

function makeCleanup(resources) {
	let cleanupPromise;
	return () => {
		cleanupPromise ??= (async () => {
			const failures = [];
			const serverResults = await Promise.allSettled(resources.servers.map(stopServer));
			for (const result of serverResults) {
				if (result.status === "rejected") failures.push(result.reason);
			}
			try {
				await resources.fake?.stop();
			} catch (error) {
				failures.push(error);
			}
			try {
				resources.cell?.cleanup();
			} catch (error) {
				failures.push(error);
			}
			const cellRemains = resources.cell !== undefined && existsSync(resources.cell.dir);
			if (cellRemains) {
				failures.push(new DifferentialHarnessError("Differential cell was not removed."));
			}
			process.stdout.write(`CELL_CLEANUP=${cellRemains ? "present" : "removed"}\n`);
			if (failures.length > 0) throw failures[0];
		})();
		return cleanupPromise;
	};
}

async function stopServer(server) {
	if (server.child.exitCode !== null || server.child.signalCode !== null) return;
	signalChild(server.child, "SIGTERM");
	if (await closesWithin(server.closed, 2500)) return;
	signalChild(server.child, "SIGKILL");
	if (!(await closesWithin(server.closed, 5000))) {
		throw new DifferentialHarnessError(`${server.label} did not exit during cleanup.`);
	}
}

function signalChild(child, signal) {
	if (child.pid === undefined) return;
	try {
		process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
	}
}

function closesWithin(closed, timeoutMs) {
	return new Promise((resolveClosed) => {
		const timer = setTimeout(() => resolveClosed(false), timeoutMs);
		closed.then(() => {
			clearTimeout(timer);
			resolveClosed(true);
		});
	});
}

function assertPortsEmpty() {
	for (const port of qaPorts) {
		const result = spawnSync("/usr/sbin/lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
		const empty = result.status === 1 && result.stdout.length === 0;
		process.stdout.write(`LSOF_PORT_${port}=${empty ? "empty" : "occupied"}\n`);
		if (!empty) throw new DifferentialHarnessError(`QA port ${port} still has a listener after cleanup.`);
	}
}

function writeJsonl(path, records) {
	writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function sanitize(value) {
	return value.replace(/[A-Za-z0-9_-]{32,}/g, "<redacted>").slice(-4000);
}

function flag(name) {
	const index = process.argv.indexOf(name);
	return index === -1 ? undefined : process.argv[index + 1];
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	try {
		await runDifferential({ scenario: flag("--scenario") ?? "handshake" });
	} catch (error) {
		process.stderr.write(`${sanitize(error instanceof Error ? error.message : String(error))}\n`);
		process.exitCode = 1;
	}
}
