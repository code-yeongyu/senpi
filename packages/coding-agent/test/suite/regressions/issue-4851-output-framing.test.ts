import { once } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it } from "vitest";
import { endpoint } from "../rpc-host-endpoint.ts";
import { cleanupIssue2184, spawnModuleChild } from "./issue-2184-support.ts";

afterEach(cleanupIssue2184);

// #4851: subprocess chunks are not records. The child waits for our release between chunks.
it("waits for the complete RESULT line before exposing its JSON", async () => {
	const child = spawnModuleChild(`
		process.stdout.write('RESULT {"ok":');
		process.stdin.once("data", () => {
			process.stdout.write('true}\\n', () => process.exit(0));
		});
	`);
	const stdout = child.child.stdout;
	if (!stdout) throw new Error("fixture stdout is piped");
	const prefix = once(stdout, "data");
	let delivered = false;
	const result = child.line("RESULT ").then((line) => {
		delivered = true;
		return line;
	});
	await prefix;
	expect(delivered, "a partial JSON line is not a complete RESULT").toBe(false);
	child.send("finish\n");
	expect(await result).toBe('RESULT {"ok":true}');
	expect(await child.exit()).toBe(0);
});

it("decodes split UTF-8 RPC output only after the record newline", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = endpoint(input, output, () => "");
	try {
		const response = client.wait((record) => record.type === "response");
		const bytes = Buffer.from('{"type":"response","message":"\uD55C"}');
		const split = bytes.indexOf(Buffer.from("\uD55C")) + 1;
		input.write(bytes.subarray(0, split));
		input.write(bytes.subarray(split));
		expect(client.records).toEqual([]);
		input.write("\n");
		expect(await response).toMatchObject({ type: "response", message: "\uD55C" });
	} finally {
		client.dispose();
	}
});

it("rejects a closed RPC stream instead of accepting its unterminated last record", async () => {
	const input = new PassThrough();
	const output = new PassThrough();
	const client = endpoint(input, output, () => "fixture ended");
	try {
		const outcome = client
			.wait((record) => record.type === "response")
			.then(
				() => "accepted unterminated record",
				() => "rejected closed stream",
			);
		input.end('{"type":"response","id":"partial"}');
		expect(await outcome).toBe("rejected closed stream");
		expect(client.records).toEqual([]);
	} finally {
		client.dispose();
	}
});
