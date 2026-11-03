import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRefreshCredential } from "../../../../ai/src/auth/refresh-credential.ts";
import { resolveProviderAuth } from "../../../../ai/src/auth/resolve.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { RuntimeCredentials } from "../../../src/core/runtime-credentials.ts";

const NOW = 1_800_000_000_000;
const FUTURE = NOW + 3_600_000;
const context = { env: async () => undefined, fileExists: async () => false };
Date.now = () => NOW;

function mailbox() {
	const values = new Map();
	const waiters = new Map();
	return {
		put(message) {
			const waiter = waiters.get(message.type);
			if (waiter) {
				waiters.delete(message.type);
				waiter(message);
			} else {
				values.set(message.type, message);
			}
		},
		take(type) {
			if (values.has(type)) {
				const value = values.get(type);
				values.delete(type);
				return Promise.resolve(value);
			}
			return new Promise((resolve) => waiters.set(type, resolve));
		},
	};
}

if (process.argv[2] === "child") {
	const [, , , authPath, mode] = process.argv;
	const inbox = mailbox();
	process.on("message", (message) => inbox.put(message));
	process.channel.ref();
	const storage = AuthStorage.create(authPath);
	const credentials = new RuntimeCredentials(storage);
	const stored = await credentials.read("fixture");
	const locked = typeof storage.withRefreshLock === "function";
	if (locked) {
		const lock = credentials.withRefreshLock.bind(credentials);
		credentials.withRefreshLock = (...args) => {
			process.send({ type: "contending" });
			return lock(...args);
		};
	} else {
		// On the pre-fix code, stop after the exchange path captured its stale
		// snapshot. This makes double-spend deterministic, not a scheduling bet.
		const read = credentials.read.bind(credentials);
		let reads = 0;
		credentials.read = async (...args) => {
			const value = await read(...args);
			if (++reads === (mode === "flat" ? 2 : 1)) {
				process.send({ type: "contending" });
				await inbox.take("continue-read");
			}
			return value;
		};
	}
	const provider = {
		id: "fixture",
		auth: {
			oauth: {
				name: "Synthetic rotating token endpoint",
				login: async () => stored,
				async refresh(credential) {
					process.send({ type: "exchange", refresh: credential.refresh });
					const response = await inbox.take("response");
					if (response.error) throw new Error(response.error);
					return response.credential;
				},
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
	};
	process.send({ type: "ready" });
	await inbox.take("go");
	try {
		const result =
			mode === "catalog"
				? await resolveRefreshCredential(provider, credentials, context, stored, new AbortController().signal)
				: await resolveProviderAuth(provider, credentials, context, {
						slotName: mode === "flat" ? undefined : mode,
					});
		process.send({ type: "result", access: mode === "catalog" ? result?.access : result?.auth.apiKey });
	} catch (error) {
		process.send({ type: "result", error: error.cause?.message ?? error.message });
	} finally {
		process.disconnect();
	}
} else {
	let deadline;
	const timeout = new Promise((_, reject) => {
		deadline = setTimeout(() => reject(new Error("Cross-process refresh did not reach its next IPC barrier")), 30_000);
	});
	const directory = mkdtempSync(join(tmpdir(), "refresh-process-"));
	const authPath = join(directory, "auth.json");
	const [firstMode, secondMode] = process.argv.slice(2);
	const independent = secondMode === "b";
	const initial = {
		type: "oauth",
		access: "old-a",
		refresh: "refresh-a",
		expires: NOW - 1,
		scopes: ["initial"],
		accounts: [
			{ name: "a", access: "old-a", refresh: "refresh-a", expires: NOW - 1 },
			{ name: "b", access: "old-b", refresh: "refresh-b", expires: NOW - 1 },
		],
	};
	writeFileSync(authPath, JSON.stringify({ fixture: initial }), { mode: 0o600 });
	const children = [];
	let closing = false;
	const spent = new Set();
	let exchanges = 0;
	function start(mode) {
		const events = mailbox();
		const child = Bun.spawn([process.execPath, "--tsconfig-override", process.argv[4], import.meta.filename, "child", authPath, mode], {
			cwd: fileURLToPath(new URL("../../../../..", import.meta.url)),
			env: { PATH: process.env.PATH, HOME: directory, SENPI_CODING_AGENT_DIR: directory },
			stdout: "pipe",
			stderr: "pipe",
			ipc(message) {
				events.put(message);
			},
		});
		children.push(child);
		const stderr = new Response(child.stderr).text();
		void child.exited.then(async (code) => {
			if (code !== 0 && !closing) throw new Error(`Refresh child exited ${code}: ${await stderr}`);
		});
		return { child, events };
	}
	function respond(worker, request) {
		exchanges++;
		if (spent.has(request.refresh)) {
			worker.child.send({ type: "response", error: "refresh_token_reused" });
			return;
		}
		spent.add(request.refresh);
		worker.child.send({
			type: "response",
			credential: {
				type: "oauth",
				access: `new-${request.refresh}`,
				refresh: `${request.refresh}-next`,
				expires: FUTURE,
				scopes: ["replacement"],
			},
		});
	}
	try {
		await Promise.race([timeout, (async () => {
		const first = start(firstMode);
		const second = start(secondMode);
		await Promise.all([first.events.take("ready"), second.events.take("ready")]);
		first.child.send({ type: "go" });
		await first.events.take("contending");
		first.child.send({ type: "continue-read" });
		const firstExchange = await first.events.take("exchange");
		second.child.send({ type: "go" });
		await second.events.take("contending");
		second.child.send({ type: "continue-read" });
		if (independent) {
			// The first endpoint remains blocked until another account completes.
			// A global exchange lock deadlocks here and fails the bounded test.
			respond(second, await second.events.take("exchange"));
			assert.equal((await second.events.take("result")).access, "new-refresh-b");
		}
		respond(first, firstExchange);
		assert.equal((await first.events.take("result")).access, "new-refresh-a");
		if (!independent) {
			const next = await Promise.race([
				second.events.take("exchange"),
				second.events.take("result"),
			]);
			if (next.type === "exchange") {
				respond(second, next);
				const result = await second.events.take("result");
				assert.equal(result.error, undefined, "two processes consumed the same rotating refresh token");
			} else {
				assert.equal(next.access, "new-refresh-a");
			}
		}
		assert.equal(exchanges, independent ? 2 : 1);
		for (const child of children) {
			assert.equal(await child.exited, 0);
		}
		const saved = JSON.parse(readFileSync(authPath, "utf8")).fixture;
		assert.equal(saved.access, "new-refresh-a");
		assert.equal(saved.refresh, "refresh-a-next");
		assert.equal(saved.expires, FUTURE);
		assert.equal(saved.accounts[0].refresh, "refresh-a-next");
		assert.equal(saved.accounts[1].refresh, independent ? "refresh-b-next" : "refresh-b");
		console.log(`PASS ${firstMode}/${secondMode}: ${exchanges} exchange(s), replacement persisted`);
		})()]);
	} finally {
		closing = true;
		clearTimeout(deadline);
		for (const child of children) {
			if (child.exitCode === null) child.kill();
			await child.exited;
		}
		rmSync(directory, { recursive: true, force: true });
	}
}
