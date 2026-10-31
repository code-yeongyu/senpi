/**
 * Test-only injection switches for the tool child (senpi#3566, plan todo 4). Each is `SENPI_TOOL_CHILD_TEST_<NAME>=1`
 * (or `=<value>`); none exists in production because nothing sets them. Holds are released by control files the test
 * creates in `SENPI_TOOL_CHILD_TEST_CONTROL_DIR`, observed with `fs.watch`, never polled.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, watch } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const PREFIX = "SENPI_TOOL_CHILD_TEST_";
export const TEST_CONTROL_DIR_ENV = `${PREFIX}CONTROL_DIR`;

export type TestSwitch =
	| "HOLD_LAUNCH_ACK"
	| "HOLD_HEARTBEAT"
	| "HOLD_LAUNCH_PROOF"
	| "STOP_AFTER_SPAWN"
	| "DROP_CONTROL_BEFORE_ACK"
	| "SKIP_ACK_WAIT"
	| "IGNORE_CANCEL"
	| "STOP_SELF"
	| "EXIT_MID_JOB"
	| "EXIT_ON_START"
	| "HANG_BEFORE_READY"
	| "BLOCK_READER";

export interface TestControls {
	readonly enabled: (name: TestSwitch) => boolean;
	readonly value: (name: TestSwitch) => string | undefined;
	readonly released: (file: string) => Promise<void>;
	/** Calls `onFile` once per control file whose name starts with `prefix`, until `close()`. */
	readonly watchPrefix: (prefix: string, onFile: (name: string) => void) => PrefixWatch;
}

export interface PrefixWatch {
	readonly ready: Promise<void>;
	close(): void;
}

export function readTestControls(env: NodeJS.ProcessEnv): TestControls {
	const dir = env[TEST_CONTROL_DIR_ENV];
	const value = (name: TestSwitch): string | undefined => {
		const raw = env[`${PREFIX}${name}`];
		return raw === undefined || raw === "" || raw === "0" ? undefined : raw;
	};
	return {
		enabled: (name) => value(name) !== undefined,
		value,
		released: (file) => {
			if (dir === undefined) return Promise.reject(new Error(`${TEST_CONTROL_DIR_ENV} is not set`));
			return waitForFile(dir, file);
		},
		watchPrefix: (prefix, onFile) => {
			if (dir === undefined)
				return { ready: Promise.reject(new Error(`${TEST_CONTROL_DIR_ENV} is not set`)), close: () => {} };
			return watchPrefix(dir, prefix, onFile);
		},
	};
}

function watchPrefix(dir: string, prefix: string, onFile: (name: string) => void): PrefixWatch {
	const seen = new Set<string>();
	const report = (name: string): void => {
		if (!name.startsWith(prefix) || seen.has(name)) return;
		seen.add(name);
		onFile(name);
	};
	const sentinel = `.watch-${process.pid}-${randomUUID()}`;
	let resend: ReturnType<typeof setTimeout> | undefined;
	let live = false;
	let markReady: () => void = () => {};
	let failReady: (error: unknown) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		markReady = resolve;
		failReady = reject;
	});
	const watcher = watch(dir, (_event, name) => {
		if (name === null) return;
		if (name === sentinel) {
			live = true;
			clearTimeout(resend);
			rmSync(join(dir, sentinel), { force: true });
			// Live from here on; files created before the watch existed are picked up once.
			for (const existing of readdirSync(dir)) report(existing);
			markReady();
			return;
		}
		if (existsSync(join(dir, name))) report(name);
	});
	const touch = (): void => {
		if (live) return;
		writeFile(join(dir, sentinel), String(Date.now())).then(
			() => {
				if (!live) resend = setTimeout(touch, 50);
			},
			(error: unknown) => failReady(error),
		);
	};
	touch();
	return {
		ready,
		close: () => {
			live = true;
			clearTimeout(resend);
			watcher.close();
			rmSync(join(dir, sentinel), { force: true });
		},
	};
}

function waitForFile(dir: string, file: string): Promise<void> {
	const path = join(dir, file);
	// macOS drops events while a watch is still starting. The one watcher proves itself live by observing its own
	// sentinel (re-sent until seen); after that, the existence re-check covers every later creation.
	const sentinel = join(dir, `.watch-${process.pid}-${randomUUID()}`);
	return new Promise((resolve, reject) => {
		let done = false;
		let resend: ReturnType<typeof setTimeout> | undefined;
		const finish = (): void => {
			if (done) return;
			done = true;
			clearTimeout(resend);
			watcher.close();
			rmSync(sentinel, { force: true });
			resolve();
		};
		const watcher = watch(dir, (_event, name) => {
			if (existsSync(path)) {
				finish();
				return;
			}
			if (name !== null && join(dir, name) === sentinel) clearTimeout(resend);
		});
		const touch = (): void => {
			if (done) return;
			writeFile(sentinel, String(Date.now())).then(
				() => {
					if (done) return;
					if (existsSync(path)) finish();
					else resend = setTimeout(touch, 50);
				},
				(error: unknown) => {
					if (done) return;
					done = true;
					watcher.close();
					reject(error);
				},
			);
		};
		touch();
	});
}
