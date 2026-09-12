#!/usr/bin/env node
/** Shared scenario steps: capability handshake, session open, fixture-log reads, teardown receipts. */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { stopHost } from "./rpc-host.mjs";
import { delay, SocketRpcClient } from "./rpc-socket-client.mjs";

export const isQuestionFrame = (message) => message.type === "extension_ui_request" && message.method === "question";

export async function connect(socketPath, label, report) {
	const client = await SocketRpcClient.connect(socketPath, label, (entry) =>
		report.observe(entry.direction, entry.label, entry.line),
	);
	await client.request({ type: "set_client_info", width: 100, capabilities: ["question"] });
	return client;
}

export async function openSession(client, { sessionPath, cwd }, timeoutMs = 20_000) {
	const response = await client.request(
		{
			type: "open_session",
			...(sessionPath ? { sessionPath } : {}),
			...(cwd ? { cwd } : {}),
		},
		timeoutMs,
	);
	if (!response.data?.sessionId) throw new Error(`open_session returned no sessionId: ${JSON.stringify(response)}`);
	return response;
}

export function readFixtureLog(path) {
	try {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

/** Teardown receipts: clients closed, host stopped, socket + sandbox gone, fake model down. */
export async function teardown(report, { clients = [], host, sandbox, label = "teardown" }) {
	for (const client of clients) client?.close();
	let hostStopError;
	if (host) {
		try {
			await stopHost(host.child);
		} catch (error) {
			hostStopError = String(error);
			report.fail(`${label}-host-stop`, { error: hostStopError });
		}
		await host.model.stop();
	}
	let socketRemoved = true;
	try {
		if (existsSync(sandbox.socketPath)) unlinkSync(sandbox.socketPath);
	} catch {
		socketRemoved = false;
	}
	const sandboxRemoved = await removeWithRetries(sandbox);
	report.pass(`${label}-cleanup`, {
		hostExited: !host || host.child.exitCode !== null || host.child.signalCode !== null,
		socketRemoved,
		sandboxRemoved,
		socketPath: sandbox.socketPath,
	});
}

/** The dying host's final flush can race the first removal; verify and retry bounded. */
export async function removeWithRetries(sandbox, attempts = 6) {
	for (let attempt = 0; attempt < attempts; attempt++) {
		sandbox.remove();
		if (!existsSync(sandbox.dir)) return true;
		await delay(200);
	}
	return !existsSync(sandbox.dir);
}
