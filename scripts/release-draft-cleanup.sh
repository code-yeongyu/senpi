#!/usr/bin/env bash
#
# Clean up the staged draft GitHub Release after a failed Build Binaries run (senpi#4173).
#
# The parent can give up while the dispatched publish-npm.yml run is still queued or
# running, and that run can publish to npm afterwards. So the draft is deleted only when
# npm does not have the version (E404, or an empty `npm view` result) AND the publish run
# can no longer publish: none was dispatched, or it completed without success. In every
# other case (npm has the version, npm cannot be asked, the run is queued or in progress,
# succeeded, or its status cannot be read) the draft is kept, the recovery steps are
# printed, and the script exits 1 so the run stays red and visible.
#
# Env:
#   RELEASE_TAG         release tag, e.g. v2026.10.24-1 (required)
#   PUBLISH_RUN_ID      id of the dispatched publish-npm.yml run, when the publish-npm job found it
#   PUBLISH_JOB_RESULT  result of the publish-npm job; "skipped" means nothing was dispatched
#   NPM_PACKAGE         package that marks the npm side as published (default @code-yeongyu/senpi)
#   GH_BIN              gh executable (default gh)
#   NPM_BIN             npm executable (default npm)

set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
PUBLISH_RUN_ID="${PUBLISH_RUN_ID:-}"
PUBLISH_JOB_RESULT="${PUBLISH_JOB_RESULT:-}"
NPM_PACKAGE="${NPM_PACKAGE:-@code-yeongyu/senpi}"
GH_BIN="${GH_BIN:-gh}"
NPM_BIN="${NPM_BIN:-npm}"
version="${RELEASE_TAG#v}"
spec="${NPM_PACKAGE}@${version}"

is_draft="$("${GH_BIN}" release view "${RELEASE_TAG}" --json isDraft --jq .isDraft 2>/dev/null || true)"
if [[ "${is_draft}" != "true" ]]; then
	echo "No draft GitHub Release ${RELEASE_TAG} to clean up."
	exit 0
fi

npm_err="$(mktemp)"
trap 'rm -f "${npm_err}"' EXIT
npm_status=0
npm_out="$("${NPM_BIN}" view "${spec}" version 2>"${npm_err}")" || npm_status=$?
npm_out="$(printf '%s' "${npm_out}" | tr -d '[:space:]')"

if [[ "${npm_status}" -eq 0 && "${npm_out}" == "${version}" ]]; then
	echo "::error::npm already has ${spec}, so the draft GitHub Release ${RELEASE_TAG} was kept instead of deleted."
	echo "Recover by publishing the kept draft after verifying both sides:"
	echo "  npm view ${spec} version"
	echo "  gh release view ${RELEASE_TAG} --json isDraft,assets"
	echo "  gh release edit ${RELEASE_TAG} --draft=false"
	exit 1
fi

if ! { [[ "${npm_status}" -eq 0 && -z "${npm_out}" ]] || grep -q 'E404' "${npm_err}"; }; then
	echo "::error::Could not determine whether npm has ${spec} (npm exit ${npm_status}); keeping the draft GitHub Release ${RELEASE_TAG}."
	cat "${npm_err}" >&2
	echo "Check npm by hand: if ${spec} is published, run 'gh release edit ${RELEASE_TAG} --draft=false'; otherwise 'gh release delete ${RELEASE_TAG} --yes'."
	exit 1
fi

# npm does not have the version. Keep the draft unless the publish run can no longer publish.
keep_for_publish_run() {
	echo "::error::npm does not have ${spec} yet, but $1; keeping the draft GitHub Release ${RELEASE_TAG}."
	echo "Once the publish run has finished:"
	echo "  ${2}"
	echo "  npm view ${spec} version"
	echo "If npm has ${spec}: gh release edit ${RELEASE_TAG} --draft=false"
	echo "Otherwise: gh release delete ${RELEASE_TAG} --yes"
	exit 1
}

if [[ "${PUBLISH_JOB_RESULT}" == "skipped" ]]; then
	echo "No publish-npm.yml run was dispatched."
elif [[ -n "${PUBLISH_RUN_ID}" ]]; then
	run_cmd="gh run view ${PUBLISH_RUN_ID}"
	if ! state="$("${GH_BIN}" run view "${PUBLISH_RUN_ID}" --json status,conclusion --jq '.status + " " + (.conclusion // "")' 2>/dev/null)"; then
		keep_for_publish_run "the status of publish-npm.yml run ${PUBLISH_RUN_ID} could not be read" "${run_cmd}"
	fi
	status="" conclusion=""
	read -r status conclusion <<<"${state}" || true
	if [[ "${status}" != "completed" ]]; then
		keep_for_publish_run "publish-npm.yml run ${PUBLISH_RUN_ID} is still ${status:-in an unknown state}" "${run_cmd}"
	fi
	if [[ "${conclusion}" == "success" ]]; then
		keep_for_publish_run "publish-npm.yml run ${PUBLISH_RUN_ID} succeeded (the registry may lag)" "${run_cmd}"
	fi
	echo "publish-npm.yml run ${PUBLISH_RUN_ID} completed with conclusion '${conclusion:-unknown}'."
else
	# The run id is unknown (the publish-npm job failed before finding it, or was cancelled).
	# Keep the draft while any recent publish-npm.yml dispatch could still publish.
	list_cmd="gh run list --workflow publish-npm.yml --event workflow_dispatch --limit 20"
	if ! in_flight="$("${GH_BIN}" run list --workflow publish-npm.yml --event workflow_dispatch --limit 20 \
		--json status --jq '[.[] | select(.status != "completed")] | length' 2>/dev/null)"; then
		keep_for_publish_run "the publish-npm.yml runs could not be listed" "${list_cmd}"
	fi
	if [[ "${in_flight}" != "0" ]]; then
		keep_for_publish_run "${in_flight:-an unknown number of} publish-npm.yml dispatch run(s) have not completed" "${list_cmd}"
	fi
	echo "No publish-npm.yml dispatch run is in flight."
fi

echo "npm does not have ${spec}; deleting the draft GitHub Release ${RELEASE_TAG}."
"${GH_BIN}" release delete "${RELEASE_TAG}" --yes
