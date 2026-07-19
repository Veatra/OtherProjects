# Trusted pull request auto-merge: operator guide

The workflow in `workflows/trusted-pr-automerge.yml` automates pull requests only when **all** of these conditions hold:

1. The PR branch belongs to this repository (forks are rejected).
2. The login is listed in the `TRUSTED_PR_AUTHORS` repository variable.
3. GitHub reports the author as `OWNER`, `MEMBER`, or `COLLABORATOR`.
4. The PR is not a draft and its head SHA remains unchanged during validation.

It uses `pull_request_target` so GitHub loads the workflow definition from the protected base branch. The job never runs build commands, scripts, actions, or dependencies from the PR. It performs Git operations only after the trust gate passes.

## Required GitHub configuration

### 1. Configure the trusted-author allowlist

Go to **Settings → Secrets and variables → Actions → Variables → New repository variable** and create:

- **Name:** `TRUSTED_PR_AUTHORS`
- **Value:** comma-, space-, or newline-separated GitHub logins, for example `your-login, codex-service-account, dependabot[bot]`

Use account logins, not display names or email addresses. Matching is case-insensitive. An allowlisted account must also have an accepted repository association; invite it under **Settings → Collaborators and teams** and grant the minimum role that can create branches and PRs. Do not add unknown bot accounts or broad organization-wide lists.

For Codex or an IDE, authenticate Git pushes as an allowlisted GitHub user or dedicated machine user and create branches in the upstream repository. PRs created from personal forks are intentionally ineligible.

### 2. Permit Actions to update branches and PRs

Under **Settings → Actions → General → Workflow permissions**:

- Select **Read and write permissions**.
- Enable **Allow GitHub Actions to create and approve pull requests** only if other automation needs approval. This workflow does not approve reviews, so the checkbox is not required here.

Organization policy can override repository workflow permissions. The workflow itself narrows the token to `contents: write` and `pull-requests: write`.

### 3. Enable GitHub auto-merge and allowed merge methods

Under **Settings → General → Pull Requests**:

- Enable **Allow auto-merge**.
- Enable **Allow squash merging**, because the workflow requests `SQUASH`.
- Optionally enable automatic head-branch deletion after merging.

To use merge commits or rebase instead, change `mergeMethod: SQUASH` to `MERGE` or `REBASE` and enable that method in repository settings. Squash is the default here because conflict resolution may add a base-to-PR merge commit that should not clutter the protected branch history.

### 4. Protect the base branch

Create a ruleset under **Settings → Rules → Rulesets** (or a classic branch protection rule) for the default/base branch. Recommended requirements are:

- Require a pull request before merging.
- Require all relevant status checks, including security and test workflows.
- Require branches to be up to date before merging when practical.
- Require conversation resolution.
- Require one or more reviews for sensitive repositories. This workflow does **not** approve a PR or bypass review requirements.
- Block force pushes and deletions on the base branch.

The push identity must be allowed to push the conflict-resolution commit to trusted **feature branches**. If a ruleset covers every branch, add an appropriate App/team bypass for feature-branch update rules or narrow that ruleset to protected branches. Never grant this workflow a bypass around required checks on the base branch.

### 5. Configure a push credential for conflict resolution

GitHub deliberately prevents pushes authenticated by the built-in `GITHUB_TOKEN` from starting most new workflow runs. Clean PRs need no extra secret, but automatically resolved PRs need their test workflows to run again on the resolution commit.

Create a dedicated GitHub App with **Contents: read and write** and **Pull requests: read and write** access, install it only on this repository, and generate a short-lived installation token in a separate trusted workflow/action. Alternatively, create a fine-grained personal access token limited to this repository, set the minimum equivalent permissions, and store it as an Actions repository secret named `TRUSTED_PR_PUSH_TOKEN`. A classic PAT may additionally need the `workflow` scope when a PR changes workflow files.

The workflow falls back to `GITHUB_TOKEN` so clean PR automation and conflict resolution remain fail-safe without this secret; however, required checks normally will not rerun after a fallback-token push, leaving the PR pending rather than merging unchecked. A short-lived App token is preferred because a stored personal token is long-lived and tied to a human account.

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
- Environment secrets are deliberately unnecessary. If switching to a GitHub App token, protect its environment with reviewers and restrict the App to this repository with only Contents and Pull requests write permissions.
- Auto-merge may complete immediately if no branch rule requires checks. Configure required checks before enabling this workflow.
- Failed trust checks are expected for forks and non-allowlisted users; maintainers should review those PRs manually rather than rerunning with elevated permissions.

## Optional enhancements

1. **Label gate:** require a maintainer-applied label such as `trusted-automerge` in the metadata validation step. This adds an explicit human opt-in.
2. **Changed-path denylist:** use the GitHub Files API (not a checkout) to block automatic merging of workflow files, ownership files, deployment code, or dependency lockfiles.
3. **GitHub App authentication:** generate a short-lived installation token to ensure the conflict-resolution push emits a new workflow event and to separate bot identity from the default Actions token.
4. **Merge queue:** for busy repositories, enable a merge queue in a ruleset and replace direct auto-merge with queue enrollment. This validates the exact integration state and reduces base-branch races.
5. **Manual conflict policy:** remove the conflict-resolution step and fail closed when semantic conflicts are too risky for the repository. This is safest for infrastructure, migrations, and security-sensitive configuration.
