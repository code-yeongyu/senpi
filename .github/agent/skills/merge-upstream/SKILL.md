---
name: merge-upstream
description: Sync a fork branch with an upstream remote using a history-preserving merge. Use this whenever the user says /merge-upstream, merge upstream, sync upstream, sync fork, or wants upstream changes integrated without rebasing or force-pushing.
---

# Merge Upstream

Sync the current fork branch with `upstream/<branch>` using a merge commit by default. Preserve local commit hashes, keep push non-destructive, and never rewrite history.

## Usage

Treat these as equivalent triggers:

```text
/merge-upstream [--base=<branch>] [--ff-allow]
merge upstream [--base=<branch>] [--ff-allow]
sync fork with upstream
```

Options:

- `--base=<branch>`: use that upstream branch instead of auto-detecting the upstream default branch.
- `--ff-allow`: allow `git merge --ff-only` when the current branch has no unique local commits. Without this, use `git merge --no-ff` to leave an explicit sync commit.

## Invariants

- Do not run `git rebase`.
- Do not run `git push --force` or `git push --force-with-lease`.
- Do not run `git stash push -a`.
- Do not bypass hooks or signing with `--no-verify` or `--no-gpg-sign`.
- Ask before pushing.

## Workflow

1. Validate the repository:

   ```bash
   git rev-parse --is-inside-work-tree
   git branch --show-current
   git remote get-url upstream
   git remote get-url origin
   ```

   Abort on detached HEAD or missing `upstream`. If `origin` is missing, continue locally and skip push.

2. If the worktree is dirty, auto-stash tracked and untracked files:

   ```bash
   git stash push -u -m "merge-upstream auto-stash $(date +%Y%m%d-%H%M%S)"
   git stash list -n 1 --format='%gd'
   git status --porcelain
   ```

   Track the stash ref. If the worktree is still dirty after stashing, stop and ask the user to clean it manually.

3. Detect the upstream target branch:

   - If `--base=<branch>` is provided, fetch and verify `upstream/<branch>`.
   - Otherwise run `git remote set-head upstream -a`, then read `refs/remotes/upstream/HEAD`.
   - If detection fails, ask the user for `--base=<branch>`.

4. Fetch enough history for a reliable merge base:

   ```bash
   git rev-parse --is-shallow-repository
   git fetch --tags upstream "+refs/heads/${upstream_branch}:refs/remotes/upstream/${upstream_branch}"
   origin_branch_exists=false
   if git remote get-url origin >/dev/null 2>&1; then
     if ! origin_branch=$(git ls-remote --heads origin "refs/heads/${current_branch}"); then
       echo "failed to inspect origin/${current_branch}" >&2
       exit 1
     elif [ -n "$origin_branch" ]; then
       git fetch origin "+refs/heads/${current_branch}:refs/remotes/origin/${current_branch}" || exit 1
       origin_branch_exists=true
     else
       echo "origin/${current_branch} does not exist; current branch is unpublished"
     fi
   fi
   git merge-base HEAD "upstream/${upstream_branch}"
   ```

   If the repository is shallow, unshallow `origin` first when available, then `upstream` only if still shallow.

   Always use the fetched remote-tracking ref as the target; do not decide from a previously cached `upstream/<branch>` tip.

5. Record the exact refs and report divergence:

   ```bash
   current_head=$(git rev-parse HEAD)
   upstream_tip=$(git rev-parse "upstream/${upstream_branch}")
   git rev-list --count "upstream/${upstream_branch}..HEAD"
   git rev-list --count "HEAD..upstream/${upstream_branch}"
   GIT_PAGER=cat git log --oneline "HEAD..upstream/${upstream_branch}"
   GIT_PAGER=cat git log --first-parent --oneline "upstream/${upstream_branch}..HEAD"
   ```

   Report `HEAD` and `upstream/${upstream_branch}` with their full SHAs.

6. Merge:

   - Behind `0` means the fetched `upstream_tip` is already an ancestor of `current_head`. Confirm that state with both checks:

     ```bash
     git merge-base --is-ancestor "$upstream_tip" "$current_head"
     upstream_range=$(git rev-list "$current_head..$upstream_tip") || exit 1
     test -z "$upstream_range"
     ```

     This completes upstream integration as a successful no-op. Report the exact refs, SHAs, ancestry result, and empty range; skip the merge, release, and gates that depend on a new upstream delta. Do not create an empty commit or pull request, or publish a branch solely to represent the sync. If an independent request explicitly approves pushing existing local commits, continue through steps 9-10; otherwise jump to step 10 to restore any auto-stash, then stop.
   - If behind is greater than `0` and `--ff-allow` is set with ahead `0`, run:

     ```bash
     git merge --ff-only "upstream/${upstream_branch}"
     ```

   - Otherwise capture `previous_head` and `upstream_tip`, then run:

     ```bash
     git merge --no-ff "upstream/${upstream_branch}" -m "merge: sync ${current_branch} with upstream/${upstream_branch}"
     ```

7. Resolve conflicts locally when they occur:

   ```bash
   git diff --name-only --diff-filter=U
   ```

   Read each conflicted file. Auto-resolve only mechanically obvious conflicts such as non-overlapping additions, import unions, formatting-only differences, or generated lockfile refreshes. For semantic conflicts, present the specific conflict and ask whether to keep ours, keep theirs, manually edit, or abort. After resolution:

   ```bash
   git add <file>
   git -c core.editor=true merge --continue
   ```

8. Verify:

   ```bash
   git rev-parse --git-path MERGE_HEAD
   git rev-parse --git-path rebase-merge
   git rev-parse --git-path rebase-apply
   git show -s --format=%P HEAD
   git rev-list --left-right --count "upstream/${upstream_branch}...HEAD"
   if [ "$origin_branch_exists" = true ]; then
     git merge-base --is-ancestor "origin/${current_branch}" HEAD
   fi
   ```

   In default mode, verify HEAD has two parents: `previous_head` as first parent and `upstream_tip` as second parent. In `--ff-allow` fast-forward mode, verify HEAD equals `upstream_tip`.

9. Push only with explicit approval:

   ```bash
   GIT_PAGER=cat git log --oneline --graph --decorate -10
   git push origin "${current_branch}"
   ```

   If the remote branch does not exist, use `git push -u origin "${current_branch}"`. If push is rejected as non-fast-forward, re-fetch and offer only non-destructive options: merge `origin/<branch>` into HEAD and retry, or stop.

10. Restore the stash when one was created:

   ```bash
   git stash pop "$stash_ref"
   ```

   If pop conflicts, leave the stash entry in place and report the exact ref.

## Final Report

Include:

- branch and upstream target, including their full SHAs
- whether merge, fast-forward, or no-op happened
- for a no-op, confirmed ancestry and the empty `HEAD..upstream/<branch>` range
- fork commits preserved
- upstream commits integrated
- push status
- stash status
- any conflicts and how they were resolved
