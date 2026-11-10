# Release process

Use the package version as both the Git tag and the GitHub Release title. For
example, use `0.2.14`, without a `v` prefix. Attach the desktop plugin archive
`dingtalk-dsh-0.2.14.tgz` and its `.sha256` checksum file.

Run the commands in PowerShell 7.4 or later. Use Node.js 24.x (at least
24.13.0), Git, and an authenticated GitHub CLI account with write access to
`euyuil/dingtalk-dsh`. Run the steps in order and stop on any error.

## 1. Select the release commit

Keep the version in `package.json` and both root version fields in
`package-lock.json` in sync. If a version change is needed, follow the
[repository guidelines](../AGENTS.md) and squash-merge the version change PR
into `main` before selecting the release commit.

Start from the repository root. Select the remote `main` commit, record its
full SHA, and confirm that the `main` push CI run for that SHA passed. For the
first release, use `0.2.14`. Check the planned tag and Release name before
starting a new release.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repo = 'euyuil/dingtalk-dsh'
$version = '0.2.14'

if ($version -cnotmatch '^\d+\.\d+\.\d+$') { throw 'Use a version such as 0.2.14.' }
$origin = git remote get-url origin
if ($origin -cnotmatch '^(https://github\.com/|git@github\.com:|ssh://git@github\.com/)euyuil/dingtalk-dsh(\.git)?$') {
  throw 'Use a checkout whose origin points to euyuil/dingtalk-dsh.'
}
git fetch origin --tags
$releaseCommit = (git rev-parse origin/main).Trim()
$runs = gh run list --repo $repo --workflow ci.yml --branch main --event push `
  --commit $releaseCommit --json headSha,conclusion,url | ConvertFrom-Json
$passingRun = $runs | Where-Object {
  $_.headSha -ceq $releaseCommit -and $_.conclusion -ceq 'success'
} | Select-Object -First 1
if (!$passingRun) { throw 'Wait for CI to pass on the selected commit.' }

$localTag = @(git tag --list $version)
$remoteTag = @(git ls-remote --refs --tags origin "refs/tags/$version")
if ($localTag.Count -or $remoteTag.Count) { throw 'The version tag already exists.' }

$passingRun.url
```

Check the [Releases page](https://github.com/euyuil/dingtalk-dsh/releases) or
`gh release list --repo $repo` for an existing Release or draft for the version.
If resuming a draft, confirm its tag resolves to the selected SHA before
reusing its assets.

## 2. Build and verify the desktop plugin

Build from a clean, detached worktree at the selected SHA. The current CI
checks the build but does not retain the archive. When CI starts retaining
release artifacts, use only the archive and checksum from the passing run for
the selected SHA.

```powershell
$releaseDir = Join-Path ([IO.Path]::GetTempPath()) "dingtalk-dsh-release-$version-$([guid]::NewGuid())"
git worktree add --detach $releaseDir $releaseCommit
Set-Location -LiteralPath $releaseDir

$manifest = Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json
$lock = Get-Content -LiteralPath package-lock.json -Raw | ConvertFrom-Json -AsHashtable
if ($manifest.version -cne $version -or $lock.version -cne $version -or
    $lock.packages[''].version -cne $version) {
  throw 'The selected commit does not match the release version.'
}

npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run pack:plugin

$asset = "dingtalk-dsh-$version.tgz"
$checksum = "$asset.sha256"
$entries = @(tar.exe -tf $asset)
$packed = tar.exe -xOf $asset package/package.json | ConvertFrom-Json
if ($packed.version -cne $version -or $packed.license -cne 'MIT' -or
    'package/LICENSE' -cnotin $entries) {
  throw 'The archive version or license does not match the release.'
}
$entries

$digest = (Get-FileHash -LiteralPath $asset -Algorithm SHA256).Hash.ToLowerInvariant()
"$digest  $asset`n" | Set-Content -LiteralPath $checksum -Encoding ascii -NoNewline
```

Review the archive listing. It should contain the built plugin, package
manifest, README, license, and example configuration. Keep real credentials,
local configuration, session databases, and customer data out of the archive.

Install this exact archive in a test DSH Desktop environment using the
[installation guide](usage.zh-CN.md). Check that the expected version is
installed, send an ordinary text message and a numbered list from the test
DingTalk account, and confirm that the replies arrive in the originating chat.

## 3. Create and review the draft

Write public release notes in `release-notes.md` and keep it out of the commit.
Include the changes, the DSH version tested, and installation instructions. For
the first release, describe the supported desktop and CLI modes and supported
incoming message types.

After the package passes review, create and push an annotated tag pointing to
the recorded SHA. Use `--verify-tag` so the CLI uses that tag when creating
the draft.

```powershell
git tag -a $version $releaseCommit -m "Release $version"
git push origin "refs/tags/$version"

$remoteCommit = git ls-remote origin "refs/tags/$version^{}"
if ($remoteCommit -cne "$releaseCommit`trefs/tags/$version^{}") {
  throw 'The remote tag does not resolve to the selected commit.'
}

gh release create $version $asset $checksum --repo $repo --verify-tag `
  --title $version --draft --notes-file release-notes.md
```

Open the draft and confirm the title, tag, release notes, and both assets.
Download the archive and verify its SHA-256 matches the checksum file. Publish
the reviewed draft with the following command.

```powershell
gh release edit $version --repo $repo --draft=false
gh release view $version --repo $repo --json tagName,isDraft,url,assets
```

Check that the published release has the intended tag and downloadable assets.
Use a new version for any later source or package correction. Keep published
tags and assets tied to their original release.
