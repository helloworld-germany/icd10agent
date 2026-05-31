#requires -Version 7
<#
  Reproduziert den Voll-Brief-Hang. Schickt N identische Voll-Brief-Requests
  hintereinander und misst Latenz + HTTP-Status. Read-only, keine Code-Aenderung.

  Usage:
    .\scripts\repro-hang.ps1                       # 5 Runs, Default
    .\scripts\repro-hang.ps1 -Runs 8 -DelaySec 2   # 8 Runs, 2s Pause
#>
param(
  [string]$ResourceGroup = 'rg-icd10-classifier',
  [string]$FunctionApp   = 'func-icd-icd10a',
  [string]$System        = 'icd10gm',
  [int]   $Runs          = 5,
  [int]   $DelaySec      = 1,
  [int]   $TimeoutSec    = 320
)

$ErrorActionPreference = 'Stop'
$key = az functionapp keys list -g $ResourceGroup -n $FunctionApp --query functionKeys.default -o tsv
if (-not $key) { throw "Kein Function-Key" }
$base = "https://$FunctionApp.azurewebsites.net"

$brief = @'
Sehr geehrte Frau Kollegin, sehr geehrter Herr Kollege,

wir berichten ueber die stationaere Behandlung unseres gemeinsamen Patienten Herrn Mueller, 68 Jahre, vom 14.05.2026 bis 22.05.2026.

Hauptdiagnose:
- Akuter ST-Hebungsinfarkt der Vorderwand (STEMI), Z.n. PCI mit Drug-Eluting-Stent in LAD am 14.05.2026.

Nebendiagnosen:
- Diabetes mellitus Typ 2 mit diabetischer Nephropathie, HbA1c 8,4%
- Arterielle Hypertonie, Stadium 2, medikamentoes eingestellt
- Hyperlipidaemie
- Chronische Niereninsuffizienz im Stadium G3a (eGFR 52 ml/min)
- Z.n. Nikotinabusus (40 packyears, sistiert seit 2019)
- Adipositas Grad I (BMI 32 kg/m2)

Mit freundlichen kollegialen Gruessen
'@
$body = @{ text = $brief } | ConvertTo-Json
$url  = "$base/api/classify?system=$System&code=$key"
Write-Host "Repro: $Runs runs against $url" -ForegroundColor Cyan
Write-Host "Brief: $($brief.Length) chars, body $($body.Length) chars`n" -ForegroundColor Gray

$results = @()
for ($i = 1; $i -le $Runs; $i++) {
  $start = Get-Date
  $statusLine = "Run #$i $($start.ToString('HH:mm:ss'))"
  Write-Host -NoNewline "$statusLine ... "
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $http = $null; $codes = $null; $cands = $null; $err = $null
  try {
    $r = Invoke-RestMethod $url -Method Post -Body $body -ContentType 'application/json' -TimeoutSec $TimeoutSec
    $http = 200
    $codes = $r.documentCodes.Count
    $cands = $r.candidates.Count
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { $http = [int]$resp.StatusCode } else { $http = -1 }
    $err   = $_.Exception.Message
  }
  $sw.Stop()
  $row = [pscustomobject]@{
    Run      = $i
    Started  = $start.ToString('HH:mm:ss')
    Sec      = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    HTTP     = $http
    Codes    = $codes
    Cands    = $cands
    Err      = if ($err) { $err.Substring(0, [math]::Min(80, $err.Length)) } else { '' }
  }
  $results += $row
  $color = if ($http -eq 200) { 'Green' } else { 'Red' }
  Write-Host ("HTTP {0}  {1,5}s  codes={2}  cands={3}" -f $http, $row.Sec, $codes, $cands) -ForegroundColor $color
  if ($i -lt $Runs) { Start-Sleep -Seconds $DelaySec }
}

Write-Host "`n--- Summary ---" -ForegroundColor Cyan
$results | Format-Table -AutoSize

$ok    = ($results | Where-Object HTTP -eq 200).Count
$slow  = ($results | Where-Object { $_.HTTP -ne 200 }).Count
$avg   = if ($ok -gt 0) { [math]::Round((($results | Where-Object HTTP -eq 200).Sec | Measure-Object -Average).Average, 1) } else { 'n/a' }
Write-Host ("OK : {0}/{1}  avg {2}s   |  FAIL: {3}/{1}" -f $ok, $Runs, $avg, $slow)
