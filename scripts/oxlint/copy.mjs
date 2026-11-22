#!/usr/bin/env node
import noEmDashCopy from "./no-em-dash-copy.mjs";
import requireSuppressionReason from "./require-suppression-reason.mjs";

export default {
	meta: { name: "senpi-copy" },
	rules: {
		"no-em-dash-copy": noEmDashCopy,
		"require-suppression-reason": requireSuppressionReason,
	},
};
