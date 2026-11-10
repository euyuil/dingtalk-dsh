param(
  [Parameter(Mandatory)] [string]$Directory,
  [Parameter(Mandatory)] [ValidatePattern('^[a-f0-9]{64}$')] [string]$ExpectedSha256
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$repo = 'euyuil/dingtalk-dsh'
$commit = (git rev-parse HEAD).Trim()
if ($env:GITHUB_REPOSITORY -cne $repo -or $env:GITHUB_REF -cne 'refs/heads/main' -or $env:GITHUB_SHA -cne $commit) {
  throw 'Publish only from the selected main workflow commit.'
}

$package = & (Join-Path $PSScriptRoot 'check-release-archive.ps1') -Directory $Directory -VerifyChecksum
if ($package.Sha256 -cne $ExpectedSha256) { throw 'The publish job did not receive the archive that passed the Desktop smoke.' }
$version = $package.Version
$archiveName = Split-Path -Leaf $package.Archive
$checksumName = Split-Path -Leaf $package.Checksum
$expectedAssets = @($archiveName, $checksumName)
$tag = "refs/tags/$version"
$peeledTag = $tag + '^{}'
$expectedTag = "$commit`t$peeledTag"

function Get-Release {
  $filter = '.[] | select(.tag_name == "' + $version + '") | {tag_name,name,draft,prerelease,assets:[.assets[].name],html_url}'
  $results = @(gh api "repos/$repo/releases?per_page=100" --paginate --jq $filter)
  if ($results.Count -gt 1) { throw 'Found multiple releases for the tag.' }
  if ($results.Count) { $results[0] | ConvertFrom-Json }
}

function Check-DownloadedAssets([string]$Destination) {
  $download = & (Join-Path $PSScriptRoot 'check-release-archive.ps1') -Directory $Destination -VerifyChecksum
  if ($download.Sha256 -cne $ExpectedSha256) { throw 'GitHub returned a different archive from the one tested.' }
}

$release = Get-Release
$remote = @(git ls-remote origin $tag $peeledTag)
if ($remote.Count -eq 0) {
  if ($release) { throw 'A release exists without a verified annotated tag.' }
  git -c 'user.name=github-actions[bot]' -c 'user.email=41898282+github-actions[bot]@users.noreply.github.com' tag -a $version $commit -m "Release $version"
  git push origin $tag
} elseif ($expectedTag -cnotin $remote) {
  throw 'The existing tag is not an annotated tag for the selected commit.'
}
if ((git ls-remote origin $peeledTag) -cne $expectedTag) { throw 'The pushed tag does not resolve to the selected commit.' }

if (!$release) {
  $notes = Join-Path $env:RUNNER_TEMP 'release-notes.md'
  @"
## Installation

Download $archiveName and verify it against $checksumName. In DSH Desktop, open **Plugins → Add Plugin** and select the archive. See the [quickstart](https://github.com/$repo/tree/$version) for DingTalk configuration and CLI setup.

## Automated verification

The release archive passed installation, plugin entry loading, and startup and shutdown checks with the official DSH Desktop Host in a clean profile. DingTalk message handling was checked with fixtures in CI.
"@ | Set-Content -LiteralPath $notes -Encoding utf8
  gh release create $version --repo $repo --verify-tag --title $version --draft --notes-file $notes --generate-notes
  $release = Get-Release
}
if (!$release -or $release.name -cne $version -or $release.prerelease) {
  throw 'The release title or type does not match the selected version.'
}
if (@($release.assets | Where-Object { $_ -cnotin $expectedAssets }).Count) {
  throw 'The release already has an unexpected attachment.'
}

if ($release.draft) {
  foreach ($file in @($package.Archive, $package.Checksum)) {
    if ((Split-Path -Leaf $file) -cnotin $release.assets) {
      gh release upload $version $file --repo $repo
    }
  }
  $draft = (New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP "draft-$version")).FullName
  gh release download $version --repo $repo --dir $draft --pattern $archiveName --pattern $checksumName
  Check-DownloadedAssets $draft
  gh release edit $version --repo $repo --draft=false
}

$release = Get-Release
if (!$release -or $release.draft -or $release.name -cne $version -or $release.prerelease -or
    @($release.assets).Count -ne 2 -or $archiveName -cnotin $release.assets -or $checksumName -cnotin $release.assets) {
  throw 'The published release metadata does not match the selected version and attachments.'
}
$public = (New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP "public-$version")).FullName
foreach ($name in $expectedAssets) {
  curl.exe --fail --silent --show-error --location --retry 2 --retry-all-errors --max-time 30 `
    --proto '=https' --proto-redir '=https' --output (Join-Path $public $name) "https://github.com/$repo/releases/download/$version/$name"
}
Check-DownloadedAssets $public
Write-Output "Verified public release: $($release.html_url)"
Write-Output "Published SHA-256: $ExpectedSha256"
