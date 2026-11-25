import { Duplex } from "node:stream";
import { describe, expect, it } from "vitest";
import { LAUNCH_KEY_CHANNEL, readLaunchKey } from "../../src/cli/launch-key.ts";

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

	it("answers undefined and opens nothing when no launch delivered a key", async () => {
		expect(await readLaunchKey(() => undefined)).toBeUndefined();
	});
});
