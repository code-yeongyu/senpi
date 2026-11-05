import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileAppears, removeSupervisedScratches, supervisedScratch } from "../helpers/rpc-supervised-host.ts";

afterEach(removeSupervisedScratches, 60_000);

describe("supervised host file readiness (senpi#4260)", () => {
	it("observes publication between the absence check and subscription", async () => {
		const qa = await supervisedScratch("publication-race");
		const dir = join(qa.root, "generation");
		await mkdir(dir);
		const file = join(dir, "drain-watch.json");
		// Test-only interleaving hook: the supervisor wins immediately after the caller's check.
		const beforeSubscribe = async () => {
			await writeFile(`${file}.tmp`, '{"pid":123}\n');
			await rename(`${file}.tmp`, file);
		};
		expect(existsSync(file)).toBe(false);
		await beforeSubscribe();

		await expect(fileAppears(file, 1_000)).resolves.toBeUndefined();
	});
	it("observes the exact atomic publication after subscribing", async () => {
		const qa = await supervisedScratch("publication-event");
		const dir = join(qa.root, "generation");
		await mkdir(dir);
		const file = join(dir, "drain-watch.json");
		const appeared = fileAppears(file, 1_000);
		await writeFile(`${file}.tmp`, '{"pid":123}\n');
		await rename(`${file}.tmp`, file);

		await expect(appeared).resolves.toBeUndefined();
	});
});
