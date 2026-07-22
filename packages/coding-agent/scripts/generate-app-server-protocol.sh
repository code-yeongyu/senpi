#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
package_dir="$(cd "${script_dir}/.." && pwd)"
protocol_dir="${package_dir}/src/modes/app-server/protocol"
generated_dir="${protocol_dir}/generated"
version_path="${protocol_dir}/PROTOCOL_VERSION.txt"

usage() {
	echo "usage: $0 [--from-checkout /path/to/codex]" >&2
}

source_dir=""
version=""

if [[ $# -eq 0 ]]; then
	if ! command -v codex >/dev/null 2>&1; then
		echo "codex not found on PATH; install codex-cli before regenerating app-server protocol types." >&2
		exit 1
	fi
elif [[ $# -eq 2 && $1 == "--from-checkout" ]]; then
	checkout_arg=$2
	if [[ ! -d ${checkout_arg} ]]; then
		echo "Codex checkout does not exist: ${checkout_arg}" >&2
		exit 1
	fi
	checkout_dir="$(cd "${checkout_arg}" && pwd)"
	source_dir="${checkout_dir}/codex-rs/app-server-protocol/schema/typescript"
	if [[ ! -d ${source_dir} || ! -f ${source_dir}/index.ts ]]; then
		echo "Codex checkout is missing app-server TypeScript schema output: ${source_dir}" >&2
		exit 1
	fi
	sha="$(git -C "${checkout_dir}" rev-parse HEAD)"
	author_date="$(git -C "${checkout_dir}" show -s --format=%as HEAD)"
	if [[ ! ${sha} =~ ^[0-9a-f]{40}$ || ! ${author_date} =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
		echo "Codex checkout did not yield a valid HEAD SHA and author date: ${checkout_dir}" >&2
		exit 1
	fi
	version="codex-git ${sha} (${author_date})"
else
	usage
	exit 2
fi

if [[ ! -f ${generated_dir}/package.json ]]; then
	echo "Local generated/package.json compilation shim is missing: ${generated_dir}/package.json" >&2
	exit 1
fi

staging_root="$(mktemp -d "${protocol_dir}/.protocol-generation.XXXXXX")"
staged_generated="${staging_root}/generated"
staged_version="${staging_root}/PROTOCOL_VERSION.txt"
backup_generated="${staging_root}/previous-generated"
backup_version="${staging_root}/previous-version"

cleanup() {
	rm -rf "${staging_root}"
}
trap cleanup EXIT

mkdir -p "${staged_generated}"
if [[ -n ${source_dir} ]]; then
	cp -R "${source_dir}/." "${staged_generated}/"
else
	command codex app-server generate-ts --experimental --out "${staged_generated}"
	version="$(command codex --version | sed -E 's/.* ([0-9]+[.][0-9]+[.][0-9]+).*/\1/')"
fi
cp "${generated_dir}/package.json" "${staged_generated}/package.json"
printf '%s\n' "${version}" > "${staged_version}"

mv "${generated_dir}" "${backup_generated}"
if [[ -f ${version_path} ]]; then
	mv "${version_path}" "${backup_version}"
fi

if ! mv "${staged_generated}" "${generated_dir}"; then
	mv "${backup_generated}" "${generated_dir}"
	if [[ -f ${backup_version} ]]; then
		mv "${backup_version}" "${version_path}"
	fi
	exit 1
fi

if ! mv "${staged_version}" "${version_path}"; then
	rm -rf "${generated_dir}"
	mv "${backup_generated}" "${generated_dir}"
	if [[ -f ${backup_version} ]]; then
		mv "${backup_version}" "${version_path}"
	fi
	exit 1
fi
