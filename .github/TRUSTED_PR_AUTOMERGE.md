# Trusted pull request auto-merge: operator guide

The workflow in `workflows/trusted-pr-automerge.yml` automates pull requests only when **all** of these conditions hold:

1. The PR branch belongs to this repository (forks are rejected).
2. The login is listed in the `TRUSTED_PR_AUTHORS` repository variable.
3. GitHub reports the author as `OWNER`, `MEMBER`, or `COLLABORATOR`.
4. The PR is not a draft and its head SHA remains unchanged during validation.

It uses `pull_request_target` so GitHub loads the workflow definition from the protected base branch. The job never runs build commands, scripts, actions, or dependencies from the PR. It performs Git operations only after the trust gate passes.

## Does this work for a private repository on GitHub Free?

**Yes, with `DIRECT` mode and important limitations.** GitHub Actions is available for private repositories on GitHub Free, subject to the account's included Actions minutes and storage. However, GitHub's native protected branches and native pull-request auto-merge are not available for a private repository owned by a GitHub Free account. Those repository features require GitHub Pro (personal account), GitHub Team (organization), or an applicable Enterprise plan.

GitHub documents these plan boundaries in [About protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [Managing auto-merge](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-auto-merge-for-pull-requests-in-your-repository), and [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions). At the time this guide was updated, GitHub Free included a monthly private-repository Actions allowance; consult the billing page rather than hard-coding that allowance into operational assumptions because GitHub may change quotas.

This workflow therefore supports two deliberately explicit modes:

| Mode | Intended plan/repository | Merge behavior | Safety boundary |
| --- | --- | --- | --- |
| `AUTO` (default) | Public repositories, or private repositories with Pro/Team/Enterprise features | After the trust gate succeeds, a separate finalizer approves the PR; it immediately squash-merges a clean PR or enables native auto-merge when GitHub requirements remain | Recommended for this public repository |
| `DIRECT` | Private repositories on GitHub Free | Verifies explicitly named check runs on the exact head SHA, then calls GitHub's squash-merge API | Compatible, but cannot replace unavailable branch protection or enforce reviews platform-wide |

`DIRECT` mode refuses to run if `TRUSTED_REQUIRED_CHECKS` is empty. It also rechecks the PR SHA immediately before merging. This prevents an unchecked commit from being substituted, but it cannot stop someone with repository write access from merging manually or pushing directly to the default branch because GitHub Free private repositories do not provide protected-branch enforcement. Upgrade to GitHub Pro/Team if that enforcement matters.

## Required GitHub configuration

### 1. Configure the trusted-author allowlist

Go to **Settings → Secrets and variables → Actions → Variables → New repository variable** and create:

- **Name:** `TRUSTED_PR_AUTHORS`
- **Value:** comma-, space-, or newline-separated GitHub logins, for example `your-login, codex-service-account, dependabot[bot]`

Use account logins, not display names or email addresses. Matching is case-insensitive. An allowlisted account must also have an accepted repository association; invite it under **Settings → Collaborators and teams** and grant the minimum role that can create branches and PRs. Do not add unknown bot accounts or broad organization-wide lists.

For Codex or an IDE, authenticate Git pushes as an allowlisted GitHub user or dedicated machine user and create branches in the upstream repository. PRs created from personal forks are intentionally ineligible.

### 2. Select the plan-compatible merge mode

Create another Actions repository variable:

- **Name:** `TRUSTED_MERGE_MODE`
- **Value for a private repository on GitHub Free:** `DIRECT`
- **Value when native auto-merge and branch protection are available:** `AUTO`

The default is `AUTO`, intentionally. This means a private GitHub Free repository fails at GitHub's native auto-merge API rather than silently falling back to a less strongly protected direct merge. You must consciously select `DIRECT`.

When using `DIRECT`, also create:

- **Name:** `TRUSTED_REQUIRED_CHECKS`
- **Value:** exact check-run names separated by commas or newlines, for example:

```text
test
lint
```

Use the check names displayed in the PR's **Checks** section. Spaces inside a name are preserved; commas and newlines are delimiters. Each named check must finish with the exact `success` conclusion on the exact SHA being merged. Missing, cancelled, skipped, neutral, timed-out, or failed checks prevent merging. The workflow waits up to five minutes and can then be rerun after slower checks finish.

Do not put this workflow's own job name (`Validate trust and prepare auto-merge`) in the list because a job cannot wait for itself to finish. Keep test/build checks in a separate `pull_request` workflow with read-only permissions.

### 3. Permit Actions to update branches and PRs

Under **Settings → Actions → General → Workflow permissions**:

- Select **Read and write permissions**.
- Enable **Allow GitHub Actions to create and approve pull requests**. The finalizer submits the requested automated policy approval after independently repeating every trust and SHA check.

Organization policy can override repository workflow permissions. The workflow itself narrows the token to `contents: write` and `pull-requests: write`.

### 4. Enable GitHub auto-merge and allowed merge methods (`AUTO` only)

Under **Settings → General → Pull Requests**:

- Enable **Allow auto-merge**.
- Enable **Allow squash merging**, because the workflow requests `SQUASH`.
- Optionally enable automatic head-branch deletion after merging.

Skip this section in `DIRECT` mode on GitHub Free; these native controls are unavailable for a private Free repository. `DIRECT` performs a squash merge through the API only after its configured checks pass.

To use merge commits or rebase instead, change `mergeMethod: SQUASH` to `MERGE` or `REBASE` and enable that method in repository settings. Squash is the default here because conflict resolution may add a base-to-PR merge commit that should not clutter the protected branch history.

### 5. Protect the base branch (`AUTO` when supported)

Create a ruleset under **Settings → Rules → Rulesets** (or a classic branch protection rule) for the default/base branch. Recommended requirements are:

- Require a pull request before merging.
- Require all relevant status checks, including security and test workflows.
- Require branches to be up to date before merging when practical.
- Require conversation resolution.
- Optionally require one approving review. The finalizer's `github-actions[bot]` policy approval can satisfy it when GitHub accepts Actions approvals; this is automated trust approval, not independent human code review.
- Block force pushes and deletions on the base branch.

The push identity must be allowed to push the conflict-resolution commit to trusted **feature branches**. If a ruleset covers every branch, add an appropriate App/team bypass for feature-branch update rules or narrow that ruleset to protected branches. Never grant this workflow a bypass around required checks on the base branch.

For a private repository on GitHub Free, this protection is unavailable. `DIRECT` mode compensates only for this workflow's own merge decision by checking named checks and the immutable SHA. It cannot prevent manual merges or direct pushes by collaborators. Keep write access extremely limited or upgrade the repository owner to GitHub Pro/Team.

### 6. Configure a push credential for conflict resolution

GitHub deliberately prevents pushes authenticated by the built-in `GITHUB_TOKEN` from starting most new workflow runs. Clean PRs need no extra secret, but automatically resolved PRs need their test workflows to run again on the resolution commit.

Create a dedicated GitHub App with **Contents: read and write** and **Pull requests: read and write** access, install it only on this repository, and generate a short-lived installation token in a separate trusted workflow/action. Alternatively, create a fine-grained personal access token limited to this repository, set the minimum equivalent permissions, and store it as an Actions repository secret named `TRUSTED_PR_PUSH_TOKEN`. A classic PAT may additionally need the `workflow` scope when a PR changes workflow files.

The workflow falls back to `GITHUB_TOKEN` so clean PR automation and conflict resolution remain fail-safe without this secret; however, required checks normally will not rerun after a fallback-token push, leaving the PR pending rather than merging unchecked. A short-lived App token is preferred because a stored personal token is long-lived and tied to a human account.

This credential is especially important in `DIRECT` mode: after a conflict-resolution push, the explicitly named checks must run on the new resolution SHA. If the built-in token suppresses those runs, the five-minute check gate fails safely.

## Merge-conflict behavior

When GitHub reports a conflict, the workflow checks out the base tip and merges the validated PR SHA using Git's `ort` strategy with `-X theirs`. Because the base is the current branch, “theirs” means the PR:

- Conflicting hunks prefer the PR version.
- Non-conflicting changes from both base and PR remain.
- Modify/delete, rename, binary, and complex semantic conflicts still follow Git's strategy behavior; “prefer theirs” is not a correctness proof.
- A lease-protected push fails instead of overwriting a newer contributor commit.

The workflow enables auto-merge for the new resolution SHA immediately after pushing. With `TRUSTED_PR_PUSH_TOKEN` configured, push/PR workflows run against that exact result; branch protection keeps auto-merge pending until they pass. Without the secret, GitHub normally suppresses those new workflow runs, so a maintainer must cause the checks to run or update the branch manually. The workflow never bypasses missing checks.

## Operational and security notes

- Pin third-party actions to full commit SHAs for stronger supply-chain control. `actions/github-script@v7` is readable and receives only trusted metadata, but a SHA pin is stricter than a major tag.
- Keep the workflow on a protected default branch and require CODEOWNERS review for `.github/workflows/**` changes.
- Do not add `actions/checkout` of the PR, `npm install`, tests, composite actions from the PR, or any command that interprets PR files to this `pull_request_target` job. Run ordinary tests in a separate `pull_request` workflow with read-only permissions.
- `AUTO` mode uses `trusted-pr-finalize.yml` only after the trust-gate workflow succeeds. This avoids GitHub's `Pull request is in unstable status` error caused by trying to enable auto-merge while the gate's own check was still running.
- Environment secrets are deliberately unnecessary. If switching to a GitHub App token, protect its environment with reviewers and restrict the App to this repository with only Contents and Pull requests write permissions.
- Auto-merge may complete immediately if no branch rule requires checks. Configure required checks before enabling this workflow.
- In `DIRECT` mode, check names are security configuration. Review changes to `TRUSTED_REQUIRED_CHECKS` as carefully as workflow changes, and never remove every meaningful test merely to make a PR merge.
- GitHub Free private-repository Actions usage consumes the repository owner's included minutes. Conflict polling occupies a Linux runner for up to five minutes; rerun only after checking whether slow tests have completed.
- Failed trust checks are expected for forks and non-allowlisted users; maintainers should review those PRs manually rather than rerunning with elevated permissions.

## Optional enhancements

1. **Label gate:** require a maintainer-applied label such as `trusted-automerge` in the metadata validation step. This adds an explicit human opt-in.
2. **Changed-path denylist:** use the GitHub Files API (not a checkout) to block automatic merging of workflow files, ownership files, deployment code, or dependency lockfiles.
3. **GitHub App authentication:** generate a short-lived installation token to ensure the conflict-resolution push emits a new workflow event and to separate bot identity from the default Actions token.
4. **Merge queue:** for busy repositories, enable a merge queue in a ruleset and replace direct auto-merge with queue enrollment. This validates the exact integration state and reduces base-branch races.
5. **Manual conflict policy:** remove the conflict-resolution step and fail closed when semantic conflicts are too risky for the repository. This is safest for infrastructure, migrations, and security-sensitive configuration.
