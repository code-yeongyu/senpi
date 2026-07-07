#!/usr/bin/env node
import assert from "node:assert/strict";

const oldLocalReleaseRegex = /directory: "packages\/pty", name: "@earendil-works\/pi-pty"/;
const brokenLocalReleaseSource = [
	"const packages = [",
	'  { directory: "packages/ai", name: "@earendil-works/pi-ai" },',
	"];",
	'// directory: "packages/pty", name: "@earendil-works/pi-pty"',
].join("\n");

assert.match(brokenLocalReleaseSource, oldLocalReleaseRegex);
console.log("old local-release regex assertion: PASS on source where packages/pty is only a comment");

const fakeWorkspacePackages = ["packages/pty/package.json"];
assert.ok(fakeWorkspacePackages.includes("packages/pty/package.json"));

const ptyPackage = { version: "0.0.0" };
const targetVersion = "2099.1.2";
const releaseBehaviorWouldFail = ptyPackage.version !== targetVersion;
assert.equal(releaseBehaviorWouldFail, true);
console.log("old release constant-membership assertion: PASS while pty package version remains 0.0.0");
console.log("behavior-focused replacement must observe build/pack calls and package.json version mutation");
