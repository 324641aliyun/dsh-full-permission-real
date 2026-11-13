# Guided publish script for dsh-full-permission-real.
#
# It publishes the npm package first and then pushes the repository that hosts
# `market/index.json`. Every step checks its prerequisite and stops on the first
# failure; nothing is retried automatically.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\publish.ps1 -Owner 324641aliyun
#   powershell -ExecutionPolicy Bypass -File tools\publish.ps1 -Owner <owner> -SkipNpm
#   powershell -ExecutionPolicy Bypass -File tools\publish.ps1 -Owner <owner> -DryRun
#
param(
  [string]$Owner = '324641aliyun',
  [string]$Repository = 'dsh-full-permission-real',
  [switch]$SkipNpm,
  [switch]$SkipGit,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root
$branch = 'main'

function Step([string]$message) { Write-Host "`n=== $message ===" -ForegroundColor Cyan }
function Fail([string]$message) { Write-Host "STOP: $message" -ForegroundColor Red; exit 1 }
function Run([string[]]$argv, [string]$what) {
  Write-Host "> $($argv -join ' ')"
  if ($DryRun) { Write-Host '  (dry run)' ; return }
  & $argv[0] $argv[1..($argv.Count - 1)]
  if ($LASTEXITCODE -ne 0) { Fail "$what failed with exit code $LASTEXITCODE" }
}

Step 'Preflight'
if (-not $DryRun) {
  $who = (cmd /c 'npm whoami 2>&1')
  if ($LASTEXITCODE -ne 0) { Fail "npm is not logged in ($who). Run: cmd /c npm login" }
  Write-Host "npm user: $who"
}
$pkg = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
Write-Host "package: $($pkg.name)@$($pkg.version)"
if ($pkg.name -ne 'dsh-full-permission-real') { Fail "unexpected package name $($pkg.name)" }

Step 'Validate market artifacts'
Run @('node', 'market/validate.mjs') 'market validation'

if (-not $SkipNpm) {
  Step 'Publish to npm'
  Run @('cmd', '/c', 'npm', 'publish', '--access', 'public') 'npm publish'
  Write-Host "npm: https://www.npmjs.com/package/$($pkg.name)/v/$($pkg.version)"
}

if (-not $SkipGit) {
  Step 'Push repository'
  if (-not (Test-Path (Join-Path $root '.git'))) {
    Run @('git', 'init') 'git init'
  }
  $name = (git config user.name) 2>$null
  if ([string]::IsNullOrWhiteSpace($name)) { Fail 'git user.name is unset; run: git config --global user.name "..."' }
  $email = (git config user.email) 2>$null
  if ([string]::IsNullOrWhiteSpace($email)) { Fail 'git user.email is unset; run: git config --global user.email "..."' }
  Run @('git', 'add', '-A') 'git add'
  $status = (git status --porcelain) 2>$null
  if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Host 'nothing to commit'
  } else {
    Run @('git', 'commit', '-m', "Release $($pkg.name) $($pkg.version)") 'git commit'
  }
  $branch = ((git rev-parse --abbrev-ref HEAD) 2>$null)
  if ([string]::IsNullOrWhiteSpace($branch) -or $branch -eq 'HEAD') { $branch = 'main' }
  $remotes = (git remote) 2>$null
  if ($remotes -notcontains 'origin') {
    Run @('git', 'remote', 'add', 'origin', "https://github.com/$Owner/$Repository.git") 'git remote add'
  } elseif (-not $DryRun) {
    $existing = (git remote get-url origin)
    if ($existing -notmatch [regex]::Escape("$Owner/$Repository")) {
      Write-Host "WARNING: origin already points at $existing" -ForegroundColor Yellow
      Fail "refusing to push to a different repository; expected $Owner/$Repository"
    }
  }
  Run @('git', 'push', '-u', 'origin', $branch) 'git push'
  if (-not $DryRun) {
    $commit = (git rev-parse HEAD)
    Write-Host "commit: $commit"
    Write-Host "index: https://raw.githubusercontent.com/$Owner/$Repository/$branch/market/index.json"
    Write-Host "git install target: git+https://github.com/$Owner/$Repository.git#$commit"
  }
}

Step 'Done'
Write-Host @"
Next steps:
  1. Add the index URL in Plugins -> Discover -> Add index source:
     https://raw.githubusercontent.com/$Owner/$Repository/$branch/market/index.json
  2. Confirm Discover lists "Full permission (real)" and install it.
  3. If you publish a new version, update market/index.json first and re-run this script.
"@
