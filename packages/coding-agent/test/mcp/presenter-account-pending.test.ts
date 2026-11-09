import { once } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { McpPresenterAccounts, type PresenterAccountAuthority } from "../../src/modes/rpc/mcp-presenter-account.ts";
import { installation, issuer } from "./fixtures/presenter-account-host.ts";

function heldAccounts() {
	let release = () => {};
	let entered = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const verifying = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const real = issuer.authority({ account: "account-a" });
	const authority: PresenterAccountAuthority = {
		...real,
		verify: async (...args) => {
			entered();
			await gate;
			return real.verify(...args);
		},
	};
	const accounts = new McpPresenterAccounts("host-instance", new Map(), authority, () => {});
	const enroll = (stream: PassThrough, frame: Record<string, unknown>) =>
		accounts.receive(stream, frame, true, () => {});
	return { accounts, enroll, verifying, release: () => release() };
}

async function firstRecord(stream: PassThrough): Promise<Record<string, unknown>> {
	const [chunk] = await once(stream, "data");
	return JSON.parse(String(chunk).split("\n")[0] ?? "");
}

it("a frame that arrives while the attestation is being verified closes the connection", async () => {
	const held = heldAccounts();
	const device = installation();
	const stream = new PassThrough();
	held.enroll(stream, device.frame(issuer.mint(device.publicKey)));
	await held.verifying;
	expect(held.accounts.receive(stream, { type: "proof", signature: "0".repeat(128) }, false, () => {})).toBe(true);
	expect(stream.destroyed).toBe(true);
	held.release();
});

it("a connection closed while its attestation is being verified leaves the jti unused", async () => {
	const held = heldAccounts();
	const device = installation();
	const token = issuer.mint(device.publicKey);
	const closed = new PassThrough();
	held.enroll(closed, device.frame(token));
	await held.verifying;
	closed.destroy();
	held.release();
	const retry = new PassThrough();
	held.enroll(retry, device.frame(token));
	expect(await firstRecord(retry)).toMatchObject({ type: "challenge", version: 1 });
});
