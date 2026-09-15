#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parse } from "yaml";

const workflow = parse(
	readFileSync(new URL("../.github/workflows/native-prebuilds.yml", import.meta.url), "utf8"),
);

const jobs = workflow.jobs;
const buildJob = jobs?.build;
const steps = buildJob?.steps ?? [];
const checkoutStep = steps.find((step) => step?.uses?.startsWith("actions/checkout"));
const stageStep = steps.find((step) => step?.name === "Stage artifact");
const uploadStep = steps.find((step) => step?.name === "Upload native prebuild");

describe("native prebuilds workflow", () => {
	it("is callable from another workflow with a source_ref input", () => {
		assert.ok(workflow.on?.workflow_call, "expected workflow_call trigger");
		const sourceRef = workflow.on.workflow_call.inputs?.source_ref;
		assert.ok(sourceRef, "expected workflow_call.inputs.source_ref");
		assert.equal(sourceRef.type, "string");
		assert.equal(sourceRef.required, false);
		assert.equal(sourceRef.default, "");
	});

	it("keeps workflow_dispatch and adds the same source_ref input", () => {
		assert.ok(workflow.on?.workflow_dispatch, "expected workflow_dispatch trigger");
		const sourceRef = workflow.on.workflow_dispatch.inputs?.source_ref;
		assert.ok(sourceRef, "expected workflow_dispatch.inputs.source_ref");
		assert.equal(sourceRef.type, "string");
		assert.equal(sourceRef.required, false);
		assert.equal(sourceRef.default, "");
	});

	it("keeps pull_request and push triggers for the native packages", () => {
		assert.ok(workflow.on?.pull_request, "expected pull_request trigger");
		assert.ok(workflow.on?.push, "expected push trigger");
	});

	it("checks out the requested source_ref instead of always using GITHUB_SHA", () => {
		assert.ok(checkoutStep, "expected Checkout step");
		assert.equal(checkoutStep.with?.ref, "${{ inputs.source_ref || github.sha }}");
	});

	it("stamps a per-host manifest with source_sha, host, and per-file sha256 hashes", () => {
		assert.ok(stageStep, "expected Stage artifact step");
		const run = stageStep.run;
		assert.ok(run, "expected Stage artifact run script");
		assert.match(run, /echo "source_sha=\$\(git rev-parse HEAD\)"/);
		assert.match(run, /echo "host=\$\{NODE_PLATFORM\}-\$\{NODE_ARCH\}"/);
		assert.match(run, /echo "sha256_senpi_pty=\$\(.*\)"/);
		assert.match(run, /echo "sha256_senpi_grep=\$\(.*\)"/);
	});

	it("keeps the artifact name keyed to the matrix host", () => {
		assert.ok(uploadStep, "expected Upload native prebuild step");
		assert.equal(uploadStep.with?.name, "${{ matrix.artifact }}");
	});
});
