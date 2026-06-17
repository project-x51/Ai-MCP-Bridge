# Proves the REAL unlock UX: a Windows Hello FACE/biometric prompt (UserConsentVerifier) gates a TPM
# decrypt (the multi-machine envelope key). The CNG per-key "password" dialog from the earlier probe was
# the wrong mechanism; Hello biometric comes from UserConsentVerifier, then we decrypt with the TPM key.
# Run with Windows PowerShell 5.1 (powershell.exe), which has the WinRT projection.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT IAsyncOperation -> await helper
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }

[Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime] | Out-Null
$availT = [Windows.Security.Credentials.UI.UserConsentVerifierAvailability,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]
$resT   = [Windows.Security.Credentials.UI.UserConsentVerificationResult,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]

Write-Host "=== AIMB vault: Windows Hello FACE gate -> TPM decrypt ===" -ForegroundColor Cyan
$avail = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()) $availT
Write-Host "Hello availability: $avail"
if ("$avail" -ne 'Available') { Write-Host "Windows Hello not available here ($avail)." -ForegroundColor Yellow; exit 2 }

Write-Host ">>> Approve the Windows Hello prompt (face / fingerprint) <<<" -ForegroundColor Green
$res = Await ([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync("Unlock the AIMB session vault")) $resT
Write-Host "Verification result: $res"
if ("$res" -ne 'Verified') { Write-Host "Not verified -> vault stays locked." -ForegroundColor Yellow; exit 3 }

# Face verified -> decrypt with the TPM (multi-machine envelope) key. No per-key password.
$prov = New-Object System.Security.Cryptography.CngProvider("Microsoft Platform Crypto Provider")
$name = "aimb-hello-demo"
try { if ([System.Security.Cryptography.CngKey]::Exists($name, $prov)) { ([System.Security.Cryptography.CngKey]::Open($name, $prov)).Delete() } } catch {}
$cp = New-Object System.Security.Cryptography.CngKeyCreationParameters
$cp.Provider = $prov
$cp.ExportPolicy = [System.Security.Cryptography.CngExportPolicies]::None
$cp.Parameters.Add((New-Object System.Security.Cryptography.CngProperty("Length",[BitConverter]::GetBytes(2048),[System.Security.Cryptography.CngPropertyOptions]::None)))
$key = [System.Security.Cryptography.CngKey]::Create([System.Security.Cryptography.CngAlgorithm]::Rsa, $name, $cp)
$rsa = New-Object System.Security.Cryptography.RSACng($key)
$secret  = [System.Text.Encoding]::UTF8.GetBytes("unlocked-after-hello-face")
$wrapped = $rsa.Encrypt($secret,  [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA1)
$back    = $rsa.Decrypt($wrapped, [System.Security.Cryptography.RSAEncryptionPadding]::OaepSHA1)
$plain   = [System.Text.Encoding]::UTF8.GetString($back)
$key.Delete()
Write-Host ("TPM decrypt after face-verify -> `"{0}`"" -f $plain) -ForegroundColor Cyan
if ($plain -eq "unlocked-after-hello-face") { Write-Host "PASS: Windows Hello FACE gated the TPM unlock." -ForegroundColor Green }
else { Write-Host "FAIL" -ForegroundColor Red }
