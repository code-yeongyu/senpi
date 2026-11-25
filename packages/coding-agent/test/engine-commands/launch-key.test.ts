import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LAUNCH_KEY_CHANNEL,
	LAUNCH_KEY_DEADLINE_MS,
	LAUNCH_KEY_FAILED_EXIT_CODE,
	LaunchKeyError,
	readLaunchKey,
	refuseUnusableLaunchKey,
} from "../../src/cli/launch-key.ts";
import { parseTable } from "../../src/private-fds.ts";

afterEach(() => {
	vi.useRealTimers();
});

/** A channel that yields one key and holds its close until the test releases it, like a descriptor closed by a thread. */
function heldChannel(key: string) {
	let release: () => void = () => {};
	const closeReleased = new Promise<void>((resolve) => {
		release = resolve;
	});
	let destroyCalled: () => void = () => {};
	const destroyed = new Promise<void>((resolve) => {
		destroyCalled = resolve;
	});
	let sent = false;
	const channel = new Duplex({
		read() {
			if (!sent) {
				sent = true;
				this.push(Buffer.from(key));
			}
			this.push(null);
		},
		write(_chunk, _encoding, done) {
			done();
		},
		destroy(error, done) {
			destroyCalled();
			void closeReleased.then(() => done(error));
		},
	});
	return { channel, destroyed, release };
}

describe("readLaunchKey answers only after its descriptor is closed (security design 5.5)", () => {
	it("does not resolve while the channel's close is still pending", async () => {
		const { channel, destroyed, release } = heldChannel("sk-held-close-7451");
		const names: string[] = [];
		let settled = false;
		const reading = readLaunchKey((name) => {
			names.push(name);
			return channel;
		}).then((key) => {
			settled = true;
			return key;
		});
		await destroyed;
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		expect(channel.closed).toBe(false);
		release();
		expect(await reading).toBe("sk-held-close-7451");
		expect(channel.closed).toBe(true);
		expect(names).toEqual([LAUNCH_KEY_CHANNEL]);
	});

	it("returns the key when destroying the channel emits an error before it closes, as an inherited stream does", async () => {
		const { channel, release } = heldChannel("sk-abort-on-destroy-7451");
		channel.on("close", () => {});
		const destroy = channel.destroy.bind(channel);
		channel.destroy = (error?: Error) => {
			const result = destroy(error);
			queueMicrotask(() => {
				channel.emit("error", Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
				release();
			});
			return result;
		};
		expect(await readLaunchKey(() => channel)).toBe("sk-abort-on-destroy-7451");
		expect(channel.closed).toBe(true);
	});

	it("fails closed with launch_key_timeout when the channel never closes, at the bound and not before", async () => {
		vi.useFakeTimers();
		const { channel } = heldChannel("sk-never-closes-7451");
		let outcome: unknown = "pending";
		const reading = readLaunchKey(() => channel).then(
			(key) => {
				outcome = { key };
			},
			(error: unknown) => {
				outcome = error;
			},
		);
		await vi.advanceTimersByTimeAsync(LAUNCH_KEY_DEADLINE_MS - 1);
		expect(outcome).toBe("pending");
		await vi.advanceTimersByTimeAsync(1);
		await reading;
		expect(outcome).toBeInstanceOf(LaunchKeyError);
		expect(outcome).toMatchObject({ code: "launch_key_timeout" });
		expect(String((outcome as Error).message)).not.toContain("sk-never-closes-7451");
	});

	it("fails closed with launch_key_unreadable when the channel was given a descriptor it cannot adopt", async () => {
		await expect(
			readLaunchKey(
				() => undefined,
				() => true,
			),
		).rejects.toMatchObject({
			code: "launch_key_unreadable",
			message: expect.stringContaining(LAUNCH_KEY_CHANNEL),
		});
	});

	it("answers undefined when an earlier hop took the key (declared null): no fallback error for a child engine", async () => {
		expect(
			await readLaunchKey(
				() => undefined,
				() => false,
			),
		).toBeUndefined();
	});

	it("strips one trailing newline, and fails closed on an empty key", async () => {
		const once = (text: string) => {
			const { channel, release } = heldChannel(text);
			release();
			return channel;
		};
		expect(await readLaunchKey(() => once("sk-newline-7451\n"))).toBe("sk-newline-7451");
		await expect(readLaunchKey(() => once("\n"))).rejects.toMatchObject({ code: "launch_key_unreadable" });
	});

	it("maps a read error to launch_key_unreadable, naming the channel and never the bytes", async () => {
		const channel = new Duplex({
			read() {
				this.push(Buffer.from("sk-partial-7451"));
				this.destroy(new Error("EIO sk-partial-7451"));
			},
			write(_chunk, _encoding, done) {
				done();
			},
		});
		const failure = await readLaunchKey(() => channel).catch((error: unknown) => error);
		expect(failure).toMatchObject({ code: "launch_key_unreadable" });
		expect(String((failure as Error).message)).toContain(LAUNCH_KEY_CHANNEL);
		expect(String((failure as Error).message)).not.toContain("sk-partial");
	});

	it("records which names a table offered a descriptor: a null name is declared, not offered", () => {
		expect([...parseTable('{"api-key":5,"presenter":null}', { platform: "linux" }).offered]).toEqual(["api-key"]);
		expect([...parseTable('{"api-key":', { platform: "linux" }).offered]).toEqual(["api-key"]);
	});

	it("the entry refuses before any hop when a descriptor was offered and cannot be adopted", () => {
		const exits: number[] = [];
		const exit = (code: number): never => {
			exits.push(code);
			throw new Error("exited");
		};
		expect(() =>
			refuseUnusableLaunchKey(
				() => true,
				() => false,
				exit,
			),
		).toThrow("exited");
		expect(exits).toEqual([LAUNCH_KEY_FAILED_EXIT_CODE]);
		refuseUnusableLaunchKey(
			() => true,
			() => true,
			exit,
		);
		refuseUnusableLaunchKey(
			() => false,
			() => false,
			exit,
		);
		expect(exits).toEqual([LAUNCH_KEY_FAILED_EXIT_CODE]);
	});

	it("answers undefined and opens nothing when no launch delivered a key", async () => {
		expect(await readLaunchKey(() => undefined)).toBeUndefined();
	});
});
