import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { opErrorCode } from "../../src/errors.ts";
import type { OpName } from "../../src/types.ts";
import {
	type ConformanceRunner,
	type ConformanceTarget,
	deferred,
	INSIDE_TEXT,
	READ_LIMIT,
	SECRET_TEXT,
	within,
	withFixture,
	writeOversizedFile,
} from "./harness.ts";

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(promise, (error: unknown) => {
		assert.equal(opErrorCode(error), code, `expected ${code}, got ${String(error)}`);
		return true;
	});
}

export function defineFileCases(runner: ConformanceRunner, target: ConformanceTarget): void {
	const { describe, it } = runner;

	describe("files.read", () => {
		it(
			"inside root returns the bytes",
			withFixture(target, async ({ ops, ctx }) => {
				const result = await ops.files.read({ path: "inside.txt" }, ctx());
				assert.equal(Buffer.from(result.bytes).toString("utf8"), INSIDE_TEXT);
				assert.equal(result.size, Buffer.byteLength(INSIDE_TEXT));
			}),
		);
		it(
			"a path outside root is a policy denial",
			withFixture(target, async ({ ops, ctx, outside }) => {
				await rejectsWith(ops.files.read({ path: join(outside, "secret.txt") }, ctx()), "policy_denied");
			}),
		);
		it(
			"a symlink escaping root is a policy denial",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.read({ path: "escape/secret.txt" }, ctx()), "policy_denied");
			}),
		);
		it(
			"a missing path is not_found",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.read({ path: "missing.txt" }, ctx()), "not_found");
			}),
		);
		it(
			"a file above readMaxBytes is limit_exceeded",
			withFixture(target, async ({ ops, ctx, root }) => {
				await writeOversizedFile(join(root, "big.bin"));
				await rejectsWith(ops.files.read({ path: "big.bin" }, ctx()), "limit_exceeded");
			}),
		);
	});

	describe("files.write", () => {
		it(
			"an already-cancelled request does not change the target",
			withFixture(target, async ({ ops, ctx, root }) => {
				const controller = new AbortController();
				controller.abort();
				await rejectsWith(
					ops.files.write(
						{ path: "inside.txt", bytes: Buffer.from("overwrite") },
						ctx({ signal: controller.signal }),
					),
					"aborted",
				);
				assert.equal(await readFile(join(root, "inside.txt"), "utf8"), INSIDE_TEXT);
			}),
		);
		it(
			"inside root writes the bytes",
			withFixture(target, async ({ ops, ctx, root }) => {
				const result = await ops.files.write({ path: "new.txt", bytes: Buffer.from("written") }, ctx());
				assert.equal(result.writtenBytes, 7);
				assert.equal(await readFile(join(root, "new.txt"), "utf8"), "written");
			}),
		);
		it(
			"a path outside root is a policy denial with no effect",
			withFixture(target, async ({ ops, ctx, outside }) => {
				await rejectsWith(
					ops.files.write({ path: join(outside, "secret.txt"), bytes: Buffer.from("x") }, ctx()),
					"policy_denied",
				);
				assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), SECRET_TEXT);
			}),
		);
		it(
			"a symlink escaping root is a policy denial with no effect",
			withFixture(target, async ({ ops, ctx, outside }) => {
				await rejectsWith(
					ops.files.write({ path: "escape/planted.txt", bytes: Buffer.from("x") }, ctx()),
					"policy_denied",
				);
				await rejectsWith(stat(join(outside, "planted.txt")), "not_found");
			}),
		);
		it(
			"a missing parent directory is not_found unless createParentDirs",
			withFixture(target, async ({ ops, ctx, root }) => {
				await rejectsWith(ops.files.write({ path: "nope/x.txt", bytes: Buffer.from("x") }, ctx()), "not_found");
				await ops.files.write({ path: "nope/x.txt", bytes: Buffer.from("x"), createParentDirs: true }, ctx());
				assert.equal(await readFile(join(root, "nope", "x.txt"), "utf8"), "x");
			}),
		);
		it(
			"readMaxBytes does not cap writes; ranges written in any order assemble the file",
			withFixture(target, async ({ ops, ctx, root }) => {
				const big = Buffer.alloc(READ_LIMIT + 1, 0x62);
				await ops.files.write({ path: "big.bin", bytes: big }, ctx());
				assert.equal((await stat(join(root, "big.bin"))).size, READ_LIMIT + 1);
				await ops.files.write({ path: "ranged.txt", bytes: Buffer.from("world"), offset: 6, total: 11 }, ctx());
				await ops.files.write({ path: "ranged.txt", bytes: Buffer.from("hello "), offset: 0, total: 11 }, ctx());
				assert.equal(await readFile(join(root, "ranged.txt"), "utf8"), "hello world");
			}),
		);
	});

	describe("files.edit", () => {
		it(
			"inside root replaces every occurrence",
			withFixture(target, async ({ ops, ctx, root }) => {
				const result = await ops.files.edit({ path: "inside.txt", exact: "l", replacement: "L" }, ctx());
				assert.equal(result.replacements, INSIDE_TEXT.split("l").length - 1);
				assert.equal(await readFile(join(root, "inside.txt"), "utf8"), INSIDE_TEXT.replaceAll("l", "L"));
				assert.equal(result.content, INSIDE_TEXT.replaceAll("l", "L"));
			}),
		);
		it(
			"a path outside root is a policy denial with no effect",
			withFixture(target, async ({ ops, ctx, outside }) => {
				await rejectsWith(
					ops.files.edit({ path: join(outside, "secret.txt"), exact: "secret", replacement: "x" }, ctx()),
					"policy_denied",
				);
				assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), SECRET_TEXT);
			}),
		);
		it(
			"a symlink escaping root is a policy denial with no effect",
			withFixture(target, async ({ ops, ctx, outside }) => {
				await rejectsWith(
					ops.files.edit({ path: "escape/secret.txt", exact: "secret", replacement: "x" }, ctx()),
					"policy_denied",
				);
				assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), SECRET_TEXT);
			}),
		);
		it(
			"a missing path is not_found",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(
					ops.files.edit({ path: "missing.txt", exact: "a", replacement: "b" }, ctx()),
					"not_found",
				);
			}),
		);
		it(
			"a file above readMaxBytes is limit_exceeded",
			withFixture(target, async ({ ops, ctx, root }) => {
				await writeOversizedFile(join(root, "big.bin"));
				await rejectsWith(
					ops.files.edit({ path: "big.bin", exact: "a", replacement: "b" }, ctx()),
					"limit_exceeded",
				);
			}),
		);
		it(
			"an empty exact is invalid_pattern and an absent exact is not_found, both without effect",
			withFixture(target, async ({ ops, ctx, root }) => {
				await rejectsWith(
					ops.files.edit({ path: "inside.txt", exact: "", replacement: "x" }, ctx()),
					"invalid_pattern",
				);
				await rejectsWith(
					ops.files.edit({ path: "inside.txt", exact: "absent", replacement: "x" }, ctx()),
					"not_found",
				);
				assert.equal(await readFile(join(root, "inside.txt"), "utf8"), INSIDE_TEXT);
			}),
		);
	});

	describe("files.glob", () => {
		it(
			"inside root finds matching files",
			withFixture(target, async ({ ops, ctx, root }) => {
				const result = await ops.files.glob({ pattern: "*.ts", cwd: "dir" }, ctx());
				assert.deepEqual(
					result.entries.map((entry) => entry.path),
					[join(root, "dir", "a.ts")],
				);
			}),
		);
		it(
			"a search directory outside root is a policy denial",
			withFixture(target, async ({ ops, ctx, outside }) => {
				await rejectsWith(ops.files.glob({ pattern: "*.txt", cwd: outside }, ctx()), "policy_denied");
			}),
		);
		it(
			"a search directory through a symlink escaping root is a policy denial",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.glob({ pattern: "*.txt", cwd: "escape" }, ctx()), "policy_denied");
			}),
		);
		it(
			"a missing search directory is not_found",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.glob({ pattern: "*", cwd: "missing-dir" }, ctx()), "not_found");
			}),
		);
		it(
			"readMaxBytes does not apply: a file above it is still listed",
			withFixture(target, async ({ ops, ctx, root }) => {
				await writeOversizedFile(join(root, "dir", "big.bin"));
				const result = await ops.files.glob({ pattern: "*.bin", cwd: "dir" }, ctx());
				assert.deepEqual(
					result.entries.map((entry) => entry.path),
					[join(root, "dir", "big.bin")],
				);
			}),
		);
	});

	describe("files.grep", () => {
		it(
			"inside root returns matching lines",
			withFixture(target, async ({ ops, ctx, root }) => {
				const result = await ops.files.grep({ path: ".", pattern: "second" }, ctx());
				assert.deepEqual(result.matches, [{ path: join(root, "inside.txt"), line: 2, text: "second line" }]);
			}),
		);
		it(
			"a path outside root is a policy denial",
			withFixture(target, async ({ ops, ctx, outside }) => {
				await rejectsWith(ops.files.grep({ path: outside, pattern: "secret" }, ctx()), "policy_denied");
			}),
		);
		it(
			"a path through a symlink escaping root is a policy denial",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.grep({ path: "escape", pattern: "secret" }, ctx()), "policy_denied");
			}),
		);
		it(
			"a missing path is not_found",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.grep({ path: "missing.txt", pattern: "x" }, ctx()), "not_found");
			}),
		);
		it(
			"a file above readMaxBytes is limit_exceeded",
			withFixture(target, async ({ ops, ctx, root }) => {
				await writeOversizedFile(join(root, "big.bin"));
				await rejectsWith(ops.files.grep({ path: "big.bin", pattern: "a" }, ctx()), "limit_exceeded");
			}),
		);
	});

	describe("files.stat", () => {
		it(
			"inside root describes the file",
			withFixture(target, async ({ ops, ctx }) => {
				const result = await ops.files.stat({ path: "inside.txt" }, ctx());
				assert.equal(result.type, "file");
				assert.equal(result.size, Buffer.byteLength(INSIDE_TEXT));
				assert.equal((await ops.files.stat({ path: "dir" }, ctx())).type, "directory");
			}),
		);
		it(
			"a path outside root is a policy denial",
			withFixture(target, async ({ ops, ctx, outside }) => {
				await rejectsWith(ops.files.stat({ path: join(outside, "secret.txt") }, ctx()), "policy_denied");
			}),
		);
		it(
			"a symlink escaping root is a policy denial",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.stat({ path: "escape" }, ctx()), "policy_denied");
			}),
		);
		it(
			"a missing path is not_found",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.stat({ path: "missing.txt" }, ctx()), "not_found");
			}),
		);
		it(
			"readMaxBytes does not apply: a file above it is described",
			withFixture(target, async ({ ops, ctx, root }) => {
				await writeOversizedFile(join(root, "big.bin"));
				assert.equal((await ops.files.stat({ path: "big.bin" }, ctx())).size, READ_LIMIT + 1);
			}),
		);
	});

	describe("files.list", () => {
		it(
			"inside root lists the entries",
			withFixture(target, async ({ ops, ctx }) => {
				const result = await ops.files.list({ path: "." }, ctx());
				const entries = Object.fromEntries(result.entries.map((entry) => [entry.name, entry.type]));
				assert.deepEqual(entries, { dir: "directory", escape: "symlink", "inside.txt": "file" });
			}),
		);
		it(
			"a path outside root is a policy denial",
			withFixture(target, async ({ ops, ctx, outside }) => {
				await rejectsWith(ops.files.list({ path: outside }, ctx()), "policy_denied");
			}),
		);
		it(
			"a symlink escaping root is a policy denial",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.list({ path: "escape" }, ctx()), "policy_denied");
			}),
		);
		it(
			"a missing path is not_found",
			withFixture(target, async ({ ops, ctx }) => {
				await rejectsWith(ops.files.list({ path: "missing-dir" }, ctx()), "not_found");
			}),
		);
		it(
			"readMaxBytes does not apply: a directory holding a file above it is listed",
			withFixture(target, async ({ ops, ctx, root }) => {
				await writeOversizedFile(join(root, "dir", "big.bin"));
				const names = (await ops.files.list({ path: "dir" }, ctx())).entries.map((entry) => entry.name).sort();
				assert.deepEqual(names, ["a.ts", "big.bin"]);
			}),
		);
	});

	describe("mutation queue", () => {
		it(
			"two mutations of one canonical path serialize: the second sees the first's result",
			withFixture(target, async ({ ops, ctx, root }) => {
				await writeFile(join(root, "shared.txt"), "zero");
				const firstEntered = deferred();
				const releaseFirst = deferred();
				const order: string[] = [];
				const policy = {
					async beforeOp(op: OpName, args: unknown) {
						const label = `${op}:${(args as { exact?: string }).exact ?? "write"}`;
						order.push(label);
						if (label === "files.write:write") {
							firstEntered.resolve();
							await releaseFirst.promise;
						}
						return { allow: true } as const;
					},
				};
				const first = ops.files.write({ path: "shared.txt", bytes: Buffer.from("first") }, ctx({ policy }));
				await within(firstEntered.promise, 5000, "the first write to enter its gate");
				// Another spelling of the same file: the queue keys on the canonical path.
				const second = ops.files.edit(
					{ path: "./dir/../shared.txt", exact: "first", replacement: "second" },
					ctx({ policy }),
				);
				releaseFirst.resolve();
				await first;
				const edited = await second;
				assert.deepEqual(order, ["files.write:write", "files.edit:first"]);
				assert.equal(edited.replacements, 1);
				assert.equal(await readFile(join(root, "shared.txt"), "utf8"), "second");
			}),
		);
		it(
			"mutations of different paths overlap",
			withFixture(target, async ({ ops, ctx, root }) => {
				const aEntered = deferred();
				const bEntered = deferred();
				const releaseA = deferred();
				const marks: Record<string, number> = {};
				const policy = {
					async beforeOp(_op: OpName, args: unknown) {
						const path = (args as { path: string }).path;
						marks[`${path}:enter`] = performance.now();
						if (path === "a.txt") {
							aEntered.resolve();
							await releaseA.promise;
							marks["a.txt:release"] = performance.now();
						} else bEntered.resolve();
						return { allow: true } as const;
					},
				};
				const a = ops.files.write({ path: "a.txt", bytes: Buffer.from("a") }, ctx({ policy }));
				await within(aEntered.promise, 5000, "write a to enter its gate");
				const b = ops.files.write({ path: "b.txt", bytes: Buffer.from("b") }, ctx({ policy }));
				// b must reach its gate while a still holds its own slot; a serialized queue would time out here.
				await within(bEntered.promise, 5000, "write b to enter while a is held");
				await b;
				releaseA.resolve();
				await a;
				assert.ok(marks["b.txt:enter"] < marks["a.txt:release"], "b ran inside a's critical section");
				assert.equal(await readFile(join(root, "a.txt"), "utf8"), "a");
				assert.equal(await readFile(join(root, "b.txt"), "utf8"), "b");
			}),
		);
	});
}
