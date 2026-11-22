#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { mergeConfig } from "vitest/config";
import { BaseSequencer } from "vitest/node";
import codingAgentConfig from "../packages/coding-agent/vitest.config.ts";
import ShardReporter from "./ci-coding-agent-shard-reporter.mjs";

class PlannedSequencer extends BaseSequencer {
	shard(specs) {
		const { root, shard } = this.ctx.config;
		const plan = JSON.parse(readFileSync(process.env.CODING_AGENT_SHARD_PLAN, "utf8"));
		if (plan.count !== shard.count) throw new Error(`Shard plan count ${plan.count} does not match ${shard.count}`);
		console.log(`Coding-agent shard mode: ${plan.shards ? "duration-balanced" : "Vitest hash (no matching timings)"}`);
		if (!plan.shards) return super.shard(specs);

		// Vitest positional filters are substring matches; use exact file identities instead.
		const selected = new Set(plan.shards[shard.index - 1]);
		return specs.filter((spec) => selected.has(relative(root, spec.moduleId)));
	}
}

export default mergeConfig(codingAgentConfig, {
	test: {
		sequence: { sequencer: PlannedSequencer },
		reporters: [new ShardReporter()],
	},
});
