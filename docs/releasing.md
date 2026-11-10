# Release process

A release publishes the exact plugin archive that passed CI and the Desktop Host smoke. The Git tag and GitHub Release title both use the package version, such as `0.2.15`. Each release includes the `.tgz` and its SHA-256 checksum.

## Prepare the version

Keep `package.json` and both root version fields in `package-lock.json` in sync. Merge a version change into `main` through a squash-merged PR. Use a new version for a source or package correction after publication. See the [repository guidelines](../AGENTS.md).

## Run the workflow

1. Wait for the `main` push run of **CI** to pass. It checks the release archive and retains the archive and checksum for 30 days.
2. In GitHub Actions, run **Release** from `main`. Set **Publish after the automated checks pass** to publish the version. Leave it off for a smoke-only run.
3. The workflow selects a successful CI run for the exact commit and downloads that run's candidate. It verifies the checksum, extracts the pinned official DSH Desktop runtime, installs the candidate in a temporary profile, loads the plugin entry, and requires the Host to report readiness and shut down cleanly.
4. The publish job uses the same candidate and SHA-256. It verifies the annotated tag, creates or resumes the release draft, downloads and checks the draft assets, publishes, and verifies both public downloads.

The Desktop smoke runs the real Windows Host with the bridge disabled. The regular CI suite checks DingTalk message handling with fixtures. A workflow failure stops publication and identifies the failing step in GitHub Actions.

If the candidate expired, rerun all **CI** jobs for that commit before starting **Release** again. A retry can resume a draft for the same commit and archive. Existing tags and published assets remain tied to their original release.
