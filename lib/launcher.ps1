# launcher.ps1 — one-time UAC launcher for the persistent elevated broker.
#
# This script itself runs with the caller's token. It only uses ShellExecute
# (`Start-Process -Verb RunAs`) to start the broker host as administrator; the
# UAC dialog the user sees belongs to that single Start-Process call. Cancelling
# (HRESULT 1223 / ERROR_CANCELLED) is written to a marker file and never retried.
#
# Parameters: -ConfigPath <absolute path to the broker config JSON>
param(
  [Parameter(Mandatory = $true)]
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$cfg = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json

try {
  $argumentList = @('"' + $cfg.hostPath + '"', '"' + $ConfigPath + '"')
  $process = Start-Process -FilePath $cfg.nodePath -ArgumentList $argumentList -Verb RunAs -WindowStyle Hidden -PassThru
  Set-Content -LiteralPath $cfg.launchedPidPath -Value ([string]$process.Id) -Encoding UTF8
}
catch {
  $detail = $_.Exception.Message
  $code = ''
  try { $code = [string]$_.Exception.HResult } catch { $code = '' }
  Set-Content -LiteralPath $cfg.cancelledPath -Value ("$code $detail").Trim() -Encoding UTF8
  exit 1
}
