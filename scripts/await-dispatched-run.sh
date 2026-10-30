#!/usr/bin/env bash
#
# Wait for a dispatched GitHub Actions run to finish (senpi#4173).
#
# Keeps waiting while the run is queued, waiting, or in progress, and fails only
# when the run itself completes with a non-success conclusion, or when the hard
# ceiling AWAIT_MAX_SECONDS passes (keep it under the job's timeout-minutes).
#
# Env:
#   RUN_ID             run to wait for (required)
#   AWAIT_MAX_SECONDS  hard ceiling in seconds (default 19800, 5.5 h)
#   AWAIT_INTERVAL     seconds between polls (default 30)
#   GH_BIN             gh executable (default gh)

set -euo pipefail

: "${RUN_ID:?RUN_ID is required}"
GH_BIN="${GH_BIN:-gh}"
AWAIT_MAX_SECONDS="${AWAIT_MAX_SECONDS:-19800}"
AWAIT_INTERVAL="${AWAIT_INTERVAL:-30}"

gh_err="$(mktemp)"
trap 'rm -f "${gh_err}"' EXIT

started="$(date +%s)"
status=""
while :; do
	conclusion=""
	# Parse stdout only: gh can print notices to stderr even when the call succeeds.
	if state="$("${GH_BIN}" run view "${RUN_ID}" --json status,conclusion --jq '.status + " " + (.conclusion // "")' 2>"${gh_err}")"; then
		read -r status conclusion <<<"${state}" || true
	else
		# A transient API error is not the child's verdict; keep polling until the ceiling.
		echo "::warning::Could not read the status of run ${RUN_ID}; retrying: $(tr '\n' ' ' <"${gh_err}")"
	fi
	elapsed=$(($(date +%s) - started))

	if [[ "${status}" == "completed" ]]; then
		if [[ "${conclusion}" == "success" ]]; then
			echo "Run ${RUN_ID} completed successfully after ${elapsed}s."
			exit 0
		fi
		echo "::error::Run ${RUN_ID} completed with conclusion '${conclusion:-unknown}'."
		exit 1
	fi

	echo "Run ${RUN_ID}: ${status:-unknown} (${elapsed}s elapsed)"
	if ((elapsed >= AWAIT_MAX_SECONDS)); then
		echo "::error::Run ${RUN_ID} did not complete within ${AWAIT_MAX_SECONDS} seconds (last status: ${status:-unknown}). It may still finish; check it before rerunning."
		exit 1
	fi
	sleep "${AWAIT_INTERVAL}"
done
