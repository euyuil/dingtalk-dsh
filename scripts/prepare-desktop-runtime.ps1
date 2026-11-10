param(
  [Parameter(Mandatory)] [string]$Directory,
  [string]$Installer
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$version = '0.2.2-rc.1'
$digest = '830947f8996dc05d991ca9133fff4d3400073e47b9cfa6507754867e79482b23'
$stage = (New-Item -ItemType Directory -Path $Directory).FullName
if (!$Installer) {
  $name = "deepseek-harness-$version-win-x64.exe"
  $Installer = Join-Path $stage $name
  curl.exe --fail --silent --show-error --location --retry 2 --connect-timeout 20 --max-time 240 `
    --proto '=https' --proto-redir '=https' --output $Installer "https://download.deepseek.com/dsh-desk/bin/win-x64/$name"
}
if ((Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash -ine $digest) {
  throw "The DSH Desktop $version installer did not match its pinned SHA-256."
}

$sevenZipCommand = Get-Command 7z.exe -ErrorAction SilentlyContinue
$sevenZip = if ($sevenZipCommand) { $sevenZipCommand.Source } else { Join-Path $env:ProgramFiles '7-Zip/7z.exe' }
$payload = '$PLUGINSDIR\app-64.7z'
$runtime = Join-Path $stage 'runtime'
& $sevenZip x -y -bso0 -bsp0 "-o$stage" -- $Installer $payload
& $sevenZip x -y -bso0 -bsp0 "-o$runtime" -- (Join-Path $stage $payload)
$exe = Get-Item -LiteralPath (Join-Path $runtime 'DeepSeek Harness.exe')
if ($exe.VersionInfo.FileVersion -cne $version) {
  throw "The extracted DSH Desktop version did not match $version."
}
$exe.FullName
