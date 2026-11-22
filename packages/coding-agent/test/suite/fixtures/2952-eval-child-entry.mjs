// Receipt child for senpi#2952: reports how the isolated CLI child was
// launched, then exits. The entry path itself is replaced by this fixture
// (see 2952-eval-parent.mjs), so the launch args are recorded by the parent.
const receipt = {
	kind: "cli-entry",
	execArgv: process.execArgv,
	argv: process.argv.slice(2),
	isolatedChild: process.env.SENPI_CLI_ISOLATED_CHILD ?? null,
};
process.send(receipt, () => process.disconnect());
