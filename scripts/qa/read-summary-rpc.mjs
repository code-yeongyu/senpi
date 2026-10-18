#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export function isolatedReadEnvironment(directory) {
	return {
		PATH: process.env.PATH,
		SystemRoot: process.env.SystemRoot,
		HOME: directory,
		USERPROFILE: directory,
		TMPDIR: directory,
		TEMP: directory,
		TMP: directory,
		SENPI_CODING_AGENT_DIR: join(directory, "agent"),
		SENPI_CODING_AGENT_SESSION_DIR: join(directory, "sessions"),
		PI_OFFLINE: "1",
		NO_COLOR: "1",
		PAGER: "cat",
		GIT_PAGER: "cat",
	};
}

export function readResultsForCalls(calls, events) {
	const results = events.filter((event) => event.type === "tool_execution_end");
	assert.equal(results.length, calls.length);
	assert.equal(new Set(results.map((event) => event.toolCallId)).size, calls.length);
	return calls.map((call) => {
		const event = results.find((event) => event.toolCallId === call.id);
		assert(event, `Missing actual read result ${call.id}`);
		assert.equal(event.toolName, "read");
		assert.equal(event.isError, false, JSON.stringify(event));
		return { id: call.id, result: event.result };
	});
}

export function startReadSession(command, directory, fixture) {
	mkdirSync(join(directory, "agent"), { recursive: true });
	writeFileSync(
		join(directory, "agent", "settings.json"),
		JSON.stringify({
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);
	const args = [
		...command.slice(1),
		"--mode",
		"rpc",
		"--no-session",
		"--offline",
		"--no-context-files",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--approve",
		"--ttsr-disabled",
		"--provider",
		"read-summary-fixture",
		"--model",
		"read-summary",
		"--tools",
		"read",
		"-e",
		fixture,
	];
	const child = spawn(command[0], args, { cwd: directory, env: isolatedReadEnvironment(directory), stdio: "pipe" });
	const events = [];
	const waiters = new Set();
	let stderr = "";
	let failure;
	const fail = (error) => {
		failure = error;
		for (const waiter of waiters) waiter.reject(error);
		waiters.clear();
	};
	child.stderr.setEncoding("utf8").on("data", (chunk) => {
		stderr += chunk;
	});
	child.once("error", fail);
	const exited = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => {
			const result = { code, signal, stderr };
			if (waiters.size) fail(new Error(`CLI exited before expected RPC event: ${JSON.stringify(result)}`));
			resolve(result);
		});
	});
	const lines = createInterface({ input: child.stdout });
	lines.on("line", (line) => {
		try {
			const event = JSON.parse(line);
			assert.equal(typeof event.type, "string");
			events.push(event);
			for (const waiter of waiters) {
				if (waiter.predicate(event)) {
					waiters.delete(waiter);
					waiter.resolve(event);
				}
			}
		} catch (error) {
			fail(error instanceof Error ? error : new Error(String(error)));
		}
	});
	function waitFor(predicate) {
		if (failure) return Promise.reject(failure);
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				waiters.delete(waiter);
				reject(new Error(`RPC event deadline exceeded; stderr=${stderr}`));
			}, 60000);
			const waiter = {
				predicate,
				resolve: (event) => {
					clearTimeout(timer);
					resolve(event);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			};
			waiters.add(waiter);
		});
	}
	async function send(request) {
		const response = waitFor((event) => event.type === "response" && event.id === request.id);
		child.stdin.write(`${JSON.stringify(request)}\n`);
		const result = await response;
		assert.equal(result.success, true, JSON.stringify(result));
		return result;
	}
	return {
		command: [command[0], ...args],
		cwd: directory,
		events,
		async ready() {
			return await send({ id: "ready", type: "get_state" });
		},
		async read(calls) {
			const start = events.length;
			// Both listeners exist before the prompt can emit any response or terminal event.
			const terminal = waitFor((event) => event.type === "agent_end" || event.type === "agent_aborted");
			const [settled] = await Promise.all([
				terminal,
				send({ id: `prompt-${start}`, type: "prompt", message: JSON.stringify(calls) }),
			]);
			assert.equal(settled.type, "agent_end");
			assert.notEqual(settled.aborted, true, JSON.stringify(settled));
			assert.equal(settled.willRetry, false);
			const results = readResultsForCalls(calls, events.slice(start));
			const final = await send({ id: `final-${start}`, type: "get_last_assistant_text" });
			assert.equal(typeof final.data.text, "string", JSON.stringify(final));
			return { results, identity: JSON.parse(final.data.text) };
		},
		async close() {
			// Use the same SIGTERM shutdown surface as the production RpcClient.stop().
			child.kill("SIGTERM");
			// Source-mode Bun can need more than 10s to tear down on loaded CI filesystems.
			const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
			try {
				return await exited;
			} finally {
				clearTimeout(timer);
				lines.close();
			}
		},
	};
}
