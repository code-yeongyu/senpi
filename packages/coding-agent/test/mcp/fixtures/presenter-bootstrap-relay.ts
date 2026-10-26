import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect, createServer, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { attachJsonlLineReader } from "../../../src/modes/rpc/jsonl.ts";
import { relayPresenterBootstrap } from "../../../src/modes/rpc/mcp-presenter-bootstrap.ts";

export async function bootstrapRelayProbe(runtime: string, env?: NodeJS.ProcessEnv): Promise<void> {
	const server = createServer();
	const accepted = once(server, "connection", { signal: AbortSignal.timeout(10_000) });
	server.listen(0, "127.0.0.1");
	await once(server, "listening", { signal: AbortSignal.timeout(10_000) });
	const address = server.address();
	assert(address && typeof address !== "string");
	const caller = connect(address.port, "127.0.0.1");
	const [upstream] = await accepted;
	assert(upstream instanceof Socket);
	const child = spawn(runtime, [fileURLToPath(new URL("./presenter-bootstrap-child.mjs", import.meta.url))], {
		stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
		...(env ? { env } : {}),
	});
	const exited = once(child, "exit", { signal: AbortSignal.timeout(10_000) });
	const owner = child.stdio[3];
	const ownerResult = Promise.withResolvers<unknown>();
	const enrolled = Promise.withResolvers<unknown>();
	const failed = Promise.withResolvers<never>();
	let handshakeComplete = false;
	let stderr = "";
	child.stderr?.on("data", (chunk) => {
		if (stderr.length < 16 * 1024) stderr += String(chunk);
	});
	child.once("error", failed.reject);
	child.once("exit", (code) => {
		if (!handshakeComplete) failed.reject(new Error(`Bootstrap fixture exited early (${code}): ${stderr}`));
	});
	const timer = setTimeout(() => failed.reject(new Error("Bootstrap fixture deadline")), 10_000);
	let stopOwner = () => {};
	let stopCaller = () => {};
	const results = Promise.race([Promise.all([ownerResult.promise, enrolled.promise]), failed.promise]);
	try {
		assert(owner instanceof Socket);
		stopOwner = attachJsonlLineReader(owner, (line) => ownerResult.resolve(JSON.parse(line)));
		stopCaller = attachJsonlLineReader(caller, (line) => {
			const value = JSON.parse(line);
			if (value.type === "challenge") caller.write(`${JSON.stringify({ type: "proof", marker: value.marker })}\n`);
			else enrolled.resolve(value);
		});
		const relayed = relayPresenterBootstrap(upstream, child);
		owner.write("owner-lifetime-canary\n");
		caller.write(`${JSON.stringify({ type: "enroll", marker: "private-bootstrap-canary" })}\n`);
		const [ownerFrame, enrollment] = await results;
		handshakeComplete = true;
		assert.deepEqual(ownerFrame, { type: "owner", value: "owner-lifetime-canary" });
		assert.deepEqual(enrollment, { type: "enrolled", marker: "private-bootstrap-canary" });
		await relayed;
		owner.end();
		assert.deepEqual(await exited, [0, null], stderr);
	} finally {
		clearTimeout(timer);
		stopOwner();
		stopCaller();
		caller.destroy();
		upstream.destroy();
		owner?.destroy();
		if (child.exitCode === null) child.kill();
		failed.reject(new Error("Bootstrap fixture closed"));
		await Promise.allSettled([results, exited]);
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}
