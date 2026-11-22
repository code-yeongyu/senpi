#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { relative } from "node:path";

export default class ShardReporter {
	files = [];

	onInit(ctx) {
		this.root = ctx.config.root;
	}

	onTestModuleEnd(module) {
		const { environmentSetupDuration, prepareDuration, collectDuration, setupDuration, duration } =
			module.diagnostic();
		this.files.push([
			relative(this.root, module.moduleId),
			environmentSetupDuration + prepareDuration + collectDuration + setupDuration + duration,
		]);
	}

	onTestRunEnd() {
		writeFileSync(process.env.CODING_AGENT_SHARD_REPORT, JSON.stringify(this.files));
	}
}
