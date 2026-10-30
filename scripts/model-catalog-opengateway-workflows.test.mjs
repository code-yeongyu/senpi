#!/usr/bin/env node

// senpi#4067: an OpenGateway outage must fail only the dedicated OpenGateway refresh. The whole-catalog
// workflows keep the committed OpenGateway catalog so every other provider still refreshes and publishes.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";
import { parseArguments } from "./run-workspaces.mjs";

const KEEP_FLAG = "--keep-last-good-opengateway";

function runCommands(workflowFile) {
	const workflow = parse(readFileSync(new URL(`../.github/workflows/${workflowFile}`, import.meta.url), "utf8"));
	return Object.values(workflow.jobs).flatMap((job) =>
		(job.steps ?? []).map((step) => step.run).filter((run) => typeof run === "string"),
	);
}

describe("OpenGateway outage handling in the model catalog workflows", () => {
	it("publishes both refreshes with the existing CI-triggering automation token", () => {
		for (const file of ["model-catalog-refresh.yml", "opengateway-catalog-refresh.yml"]) {
			const workflow = parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));
			const publisher = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
				.find((step) => step.run?.includes("node scripts/publish-catalog-refresh.mjs"));
			assert.ok(publisher, file);
			assert.equal(publisher.env.GH_TOKEN, "${{ secrets.UPSTREAM_AUTOMATION_TOKEN }}");
		}
	});

	it("keeps the last good OpenGateway catalog in the whole-catalog refresh", () => {
		const generate = runCommands("model-catalog-refresh.yml").filter((run) => run.includes("generate-models.ts"));

		assert.equal(generate.length, 1);
		assert.match(generate[0], /--strict\b/);
		assert.ok(generate[0].includes(KEEP_FLAG), generate[0]);
	});

	it("forwards the keep flag through run-workspaces in the catalog publish", () => {
		const generate = runCommands("publish-model-catalog.yml").filter((run) => run.includes("generate:model-catalog"));

		assert.equal(generate.length, 1);
		// npm appends everything after its own `--` to `run-workspaces.mjs --workspace packages/ai generate-model-catalog`.
		const npmForwarded = generate[0].split(" -- ").slice(1).join(" -- ").trim().split(/\s+/);
		const parsed = parseArguments(["--workspace", "packages/ai", "generate-model-catalog", ...npmForwarded]);
		assert.deepEqual(parsed.forwarded, [KEEP_FLAG]);
	});

	it("leaves the dedicated OpenGateway refresh strict, so it is the job that fails", () => {
		const generate = runCommands("opengateway-catalog-refresh.yml").filter((run) => run.includes("generate-models.ts"));

		assert.ok(generate.length > 0);
		for (const run of generate) {
			assert.match(run, /--strict --providers opengateway/);
			assert.ok(!run.includes(KEEP_FLAG), run);
		}
	});
});
