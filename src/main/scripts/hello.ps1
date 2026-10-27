param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [string]$Message = "Unlock Keynest"
)

$ErrorActionPreference = "Stop"

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime

  $null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $null = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
  $null = [Windows.Security.Credentials.UI.UserConsentVerificationResult, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and
      $_.GetParameters().Count -eq 1 -and
      $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    if (-not $netTask.Wait(120000)) { throw "timeout" }
    return $netTask.Result
  }

  if ($Mode -eq "check") {
    $availability = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) ([Windows.Security.Credentials.UI.UserConsentVerifierAvailability])
    Write-Output ("AVAIL:" + $availability.ToString())
  }
  elseif ($Mode -eq "verify") {
    $result = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($Message)) ([Windows.Security.Credentials.UI.UserConsentVerificationResult])
    Write-Output ("RESULT:" + $result.ToString())
  }
  else {
    Write-Output "ERROR:unknown mode"
    exit 2
  }
}
catch {
  Write-Output ("ERROR:" + $_.Exception.Message)
  exit 1
}
