import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { hashServerUrl } from "../../src/core/extensions/builtin/mcp/auth/token-store.ts";
import { cleanupRoots, makeRoot, setConfig } from "./fixtures/service-lifecycle.ts";
import { sharingHttpFixture } from "./fixtures/sharing-http.ts";

it("delivers a first request while another process holds the legacy OAuth migration lock", async () => {
	const cleanup: Array<() => Promise<void>> = [];
	const root = makeRoot("2843-oauth-migration", cleanup);
	const fixture = await sharingHttpFixture();
	const authRoot = join(root.agentDir, "mcp-auth");
	const lock = join(authRoot, `${hashServerUrl(fixture.url)}.migrate.lock`);
	await mkdir(authRoot, { recursive: true });
	await writeFile(lock, "fixture owns migration");
	setConfig(root, { fx: { type: "http", url: fixture.url, auth: "oauth", lifecycle: "eager" } });
	const started = Promise.withResolvers<void>();
	const first = Promise.withResolvers<void>();
	void first.promise.catch(() => undefined); // Early spawn errors are also reported through started.
	const worker = spawn("bun", [join(import.meta.dirname, "fixtures/first-request-oauth-worker.ts"), root.agentDir], {
		stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	const exited = new Promise<void>((resolve) => worker.once("exit", () => resolve()));
	worker.on("error", (error) => {
		started.reject(error);
		first.reject(error);
	});
	worker.on("message", (message: unknown) => {
		if (typeof message !== "object" || message === null || !("event" in message)) return;
		if (message.event === "started") started.resolve();
		if (message.event === "first-request") first.resolve();
	});
	// Observe both promises immediately, including early worker failures.
	const observedStart = bounded(started.promise, "OAuth worker did not start", 10_000);
	const observedFirst = observedStart.then(() => bounded(first.promise, "First request waited on migration", 2000));
	try {
		await observedFirst;
		expect(fixture.calls).toBe(0);
	} finally {
		worker.kill("SIGKILL");
		await bounded(exited, "OAuth worker did not exit", 5000);
		await rm(lock, { force: true });
		await fixture.close();
		await cleanupRoots(cleanup);
	}
});

function bounded(event: Promise<void>, message: string, timeout: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const signal = AbortSignal.timeout(timeout);
		const abort = () => reject(new Error(message));
		signal.addEventListener("abort", abort, { once: true });
		void event.then(
			() => {
				signal.removeEventListener("abort", abort);
				resolve();
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}
