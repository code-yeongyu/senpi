#!/usr/bin/env node
import noFixedSleep from "./no-fixed-sleep.mjs";
import noFlakeMasking from "./no-flake-masking.mjs";

export default {
	meta: { name: "senpi-testing" },
	rules: {
		"no-fixed-sleep": noFixedSleep,
		"no-flake-masking": noFlakeMasking,
	},
};
