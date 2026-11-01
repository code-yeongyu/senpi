/**
 * senpi#4602 (A-amended section 4): a successor's presenter exchange starts at P7, which can come long after the
 * host child and its supervisor opened the inherited fd 4 channel. Until the first enrollment frame arrives the
 * channel is only PARKED, bounded by the 180 s startup ceiling; the existing 30 s enrollment window starts with
 * that first frame, so a legitimately slow start never hands the exchange an already-spent window.
 */
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { relayPresenterBootstrap } from "../../src/modes/rpc/mcp-presenter-bootstrap.ts";
import { McpPresenterEnrollment } from "../../src/modes/rpc/mcp-presenter-enrollment.ts";

const describePosix = process.platform === "win32" ? describe.skip : describe;

afterEach(() => {
	vi.useRealTimers();
});

describe("host-side enrollment channel parking (senpi#4602)", () => {
	it("keeps an untouched channel past 30 s and closes it at the 180 s startup ceiling", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const stream = new PassThrough();
		new McpPresenterEnrollment("host-1", "/tmp/control.sock").bootstrap(stream, () => {});
		await vi.advanceTimersByTimeAsync(30_001);
		expect(stream.destroyed).toBe(false);
		await vi.advanceTimersByTimeAsync(180_000 - 30_001);
		expect(stream.destroyed).toBe(true);
	});
});

describePosix("relay parking (senpi#4602)", () => {
	let dir: string | undefined;
	let server: Server | undefined;

	afterEach(async () => {
		server?.close();
		if (dir) await rm(dir, { recursive: true, force: true });
	});

	async function childWithPresenterSocket(): Promise<ChildProcess> {
		dir = await mkdtemp(join(tmpdir(), "pp-"));
		const path = join(dir, "s.sock");
		const accepted = Promise.withResolvers<Socket>();
		server = createServer((peer) => accepted.resolve(peer));
		await new Promise<void>((resolve) => server?.listen(path, resolve));
		const downstream = new Socket();
		await new Promise<void>((resolve) => downstream.connect(path, resolve));
		await accepted.promise;
		return Object.assign(new EventEmitter(), { stdio: [null, null, null, null, downstream] }) as unknown as ChildProcess;
	}

	it("parks until the first upstream frame, then gives the exchange its 30 s window from that frame", async () => {
		const child = await childWithPresenterSocket();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const upstream = new PassThrough();
		let finished = false;
		void relayPresenterBootstrap(upstream, child).then(() => {
			finished = true;
		});
		await vi.advanceTimersByTimeAsync(60_000);
		expect(finished).toBe(false);
		upstream.write(`${JSON.stringify({ type: "hello" })}\n`);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(finished).toBe(true);
	});

	it("an untouched relay ends at the 180 s startup ceiling", async () => {
		const child = await childWithPresenterSocket();
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		let finished = false;
		void relayPresenterBootstrap(new PassThrough(), child).then(() => {
			finished = true;
		});
		await vi.advanceTimersByTimeAsync(179_999);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(2);
		expect(finished).toBe(true);
	});
});
