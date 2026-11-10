param(
  [string]$Directory = (Get-Location).Path,
  [switch]$VerifyChecksum
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$lock = Get-Content -LiteralPath (Join-Path $root 'package-lock.json') -Raw | ConvertFrom-Json -AsHashtable
$version = $manifest.version
if ($version -cnotmatch '^\d+\.\d+\.\d+$' -or $lock.version -cne $version -or $lock.packages[''].version -cne $version) {
  throw 'The manifest and both root lockfile versions must match a release version.'
}

$name = "dingtalk-dsh-$version.tgz"
$archive = Join-Path (Resolve-Path -LiteralPath $Directory).Path $name
$checksum = "$archive.sha256"
$entries = @(tar.exe -tf $archive)
$required = @(
  'package/package.json', 'package/LICENSE', 'package/README.md', 'package/.env.example',
  'package/config/plugin.example.yml', 'package/cordis.patch.yml',
  'package/dist/plugin.js', 'package/dist/plugin.d.ts', 'package/dist/client.js',
  'package/dist/main.js', 'package/dist/channels/dingtalk-worker.js'
)
foreach ($entry in $required) {
  if ($entry -cnotin $entries) { throw "Missing archive entry: $entry" }
}
if (@($entries | Sort-Object -CaseSensitive -Unique).Count -ne $entries.Count) {
  throw 'The archive contains duplicate entries.'
}
$unexpected = @($entries | Where-Object {
  $_ -cnotin $required -and $_ -cnotmatch '^package/dist/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\.(?:js|d\.ts)$'
})
if ($unexpected.Count) { throw "Unexpected archive entries: $($unexpected -join ', ')" }

$packed = tar.exe -xOf $archive package/package.json | ConvertFrom-Json
if ($packed.name -cne $manifest.name -or $packed.version -cne $version -or $packed.license -cne 'MIT') {
  throw 'The archive package name, version, or license does not match the release.'
}

$digest = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumLine = "$digest  $name"
if ($VerifyChecksum) {
  if ((Get-Content -LiteralPath $checksum -Raw).TrimEnd() -cne $checksumLine) {
    throw 'The archive SHA-256 does not match its checksum file.'
  }
} else {
  [IO.File]::WriteAllText($checksum, "$checksumLine`n", [Text.Encoding]::ASCII)
}

[pscustomobject]@{
  Version = $version
  Archive = $archive
  Checksum = $checksum
  Sha256 = $digest
}
