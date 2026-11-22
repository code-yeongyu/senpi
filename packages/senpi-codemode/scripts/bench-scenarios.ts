import { crashQueue100 } from "./bench-scenarios-crash.ts";
import { latencyScenarios, type Scenario } from "./bench-scenarios-latency.ts";
import { workloadScenarios } from "./bench-scenarios-workload.ts";

export const implementedScenarios: readonly Scenario[] = [...latencyScenarios, ...workloadScenarios, crashQueue100];

/**
 * Workloads that measure features later plan nodes ship. Until a node adds the feature and its scenario,
 * neither side has it, so the run records them as "not present on head" and skips them; a scenario that
 * exists on only one side invalidates the run instead.
 */
export const plannedScenarios: readonly string[] = [
	"managed-install",
	"sandbox-execute",
	"wait-1000-handles",
	"callback-roundtrip-js-py",
	"install-local-fixtures",
	"sandbox-compose",
	"sandbox-runaway",
];
