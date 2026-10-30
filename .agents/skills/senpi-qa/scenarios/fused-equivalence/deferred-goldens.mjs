// Deferred B0 goldens (LEAD ruling for #4751, 2026-10-29): the only golden cells allowed to be missing.
//
// A cell is one case on one golden platform and one surface (`rpc` -> golden/<platform>, `tui` -> golden-tui/<platform>).
// fused-equivalence-qa.mjs --compare reports a listed cell whose golden is missing as `DEFERRED(<owner>, <issue>)`. It is
// never a PASS, the summary line counts it separately, and it does not fail the run. Any other missing golden FAILS.
//
// Every entry needs an owner, a tracking issue and a due gate. A fix PR records the golden AND deletes its entry here
// in the same PR: once the golden exists, the harness FAILS the entry with "remove the deferred entry".
export const deferredGoldens = Object.freeze([
	{
		platform: "linux-x64",
		case: "E25",
		mode: "rpc",
		owner: "brain-hand-exec-p0",
		issue: "https://github.com/code-yeongyu/senpi/issues/4827",
		due: "before PGATE-P0",
	},
	{
		platform: "linux-x64",
		case: "E25",
		mode: "tui",
		owner: "brain-hand-exec-p0",
		issue: "https://github.com/code-yeongyu/senpi/issues/4826",
		due: "before PGATE-P0",
	},
	{
		platform: "linux-x64",
		case: "E27",
		mode: "rpc",
		owner: "brain-hand-exec-p0",
		issue: "https://github.com/code-yeongyu/senpi/pull/4837",
		due: "before PGATE-P0",
	},
	{
		platform: "linux-x64",
		case: "E28",
		mode: "rpc",
		owner: "brain-hand-exec-p0",
		issue: "https://github.com/code-yeongyu/senpi/issues/4829",
		due: "before PGATE-P0",
	},
]);
