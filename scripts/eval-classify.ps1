# scripts/eval-classify.ps1
# Evaluation des /api/classify Endpoints gegen einen JSONL-Goldstandard.
#
# Format pro Zeile:
#   { "id":"...", "category":"...", "text":"...", "expected_codes":["I21.0", ...], "notes":"..." }
#
# Berechnet set-basierte Metriken (Exact Match, Precision/Recall/F1)
# sowohl auf voller Code-Ebene als auch auf 3-Steller-Ebene (Kapitel+Kategorie).
#
# Aufruf:
#   ./scripts/eval-classify.ps1 -BaseUrl https://func-icd-icd11dev.azurewebsites.net `
#                               -ResourceGroup rg-icd-classifier `
#                               -FunctionApp func-icd-icd11dev `
#                               -System icd10gm `
#                               -GoldFile tests/eval/icd-gold.jsonl
#
# Oder mit explizitem Key:
#   ./scripts/eval-classify.ps1 -BaseUrl ... -Key <FUNCTION_KEY> -System icd10gm

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $BaseUrl,
    [string] $Key,
    [string] $ResourceGroup,
    [string] $FunctionApp,
    [ValidateSet('icd10gm', 'icd11')] [string] $System = 'icd10gm',
    [string] $GoldFile = "$PSScriptRoot/../tests/eval/icd-gold.jsonl",
    [string] $ReportDir = "$PSScriptRoot/../tests/eval/reports",
    [int] $TimeoutSec = 180,
    [int] $DelayMs = 1500,
    [int] $MaxRetries = 5
)

$ErrorActionPreference = 'Stop'

if (-not $Key) {
    if (-not ($ResourceGroup -and $FunctionApp)) {
        throw "Provide -Key or both -ResourceGroup and -FunctionApp."
    }
    $Key = az functionapp keys list -g $ResourceGroup -n $FunctionApp --query functionKeys.default -o tsv
    if (-not $Key) { throw "Failed to fetch function key via az." }
}

if (-not (Test-Path $GoldFile)) { throw "Gold file not found: $GoldFile" }
$null = New-Item -ItemType Directory -Force -Path $ReportDir

function Strip-CodeSuffix {
    param([string] $c)
    # Remove German Zusatzkennzeichen (G/Z/V/A) and side flags (R/L), trim whitespace.
    if (-not $c) { return '' }
    $c = $c.Trim().ToUpper()
    $c = $c -replace '\s+(G|Z|V|A)\b', ''
    $c = $c -replace '\s+(R|L|B)\b', ''
    return $c.Trim()
}

function Get-Stem {
    param([string] $c)
    $s = Strip-CodeSuffix $c
    # 3-character category (e.g. I21.0 -> I21, G81.1 -> G81).
    if ($s.Length -ge 3) { return $s.Substring(0, 3) }
    return $s
}

function Score-Set {
    param([string[]] $Predicted, [string[]] $Expected)
    $p = @($Predicted | Where-Object { $_ } | Sort-Object -Unique)
    $e = @($Expected  | Where-Object { $_ } | Sort-Object -Unique)
    $tp = @($p | Where-Object { $e -contains $_ }).Count
    $precision = if ($p.Count) { $tp / $p.Count } else { 0.0 }
    $recall    = if ($e.Count) { $tp / $e.Count } else { 0.0 }
    $f1 = if (($precision + $recall) -gt 0) { 2 * $precision * $recall / ($precision + $recall) } else { 0.0 }
    $exact = ($p.Count -eq $e.Count -and $tp -eq $e.Count)
    return [pscustomobject]@{
        TP = $tp; Precision = $precision; Recall = $recall; F1 = $f1; Exact = $exact
        Missing = @($e | Where-Object { $p -notcontains $_ })
        Extra   = @($p | Where-Object { $e -notcontains $_ })
    }
}

$cases = Get-Content $GoldFile | Where-Object { $_.Trim() } | ForEach-Object { $_ | ConvertFrom-Json }
Write-Host "Loaded $($cases.Count) gold cases from $GoldFile" -ForegroundColor Cyan
Write-Host "Target: $BaseUrl  System: $System" -ForegroundColor Cyan

$results = New-Object System.Collections.Generic.List[object]
$idx = 0
foreach ($case in $cases) {
    $idx++
    Write-Host "[$idx/$($cases.Count)] $($case.id) ($($case.category))" -ForegroundColor Yellow
    $body = @{ text = $case.text } | ConvertTo-Json -Depth 5
    $url = "$BaseUrl/api/classify?system=$System&code=$Key"

    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $resp = $null
    $lastErr = $null
    for ($attempt = 1; $attempt -le $MaxRetries; $attempt++) {
        try {
            $resp = Invoke-RestMethod -Uri $url -Method Post -Body $body -ContentType 'application/json' -TimeoutSec $TimeoutSec
            $lastErr = $null
            break
        } catch {
            $lastErr = $_
            $status = $null
            try { $status = [int]$_.Exception.Response.StatusCode } catch { }
            $retryable = ($status -eq 429) -or ($status -ge 500) -or (-not $status)
            if (-not $retryable -or $attempt -eq $MaxRetries) { break }
            $backoff = [int]([math]::Min(30000, 1000 * [math]::Pow(2, $attempt)))
            Write-Host "  attempt $attempt failed (status=$status). backing off $backoff ms" -ForegroundColor DarkYellow
            Start-Sleep -Milliseconds $backoff
        }
    }
    $sw.Stop()
    if ($null -eq $resp) {
        Write-Host "  ERROR: $($lastErr.Exception.Message)" -ForegroundColor Red
        $results.Add([pscustomobject]@{
            id = $case.id; category = $case.category; ok = $false; error = $lastErr.Exception.Message
        })
        Start-Sleep -Milliseconds $DelayMs
        continue
    }

    $predFull = @()
    if ($resp.documentCodes) {
        $predFull = @($resp.documentCodes | ForEach-Object { Strip-CodeSuffix $_.code } | Where-Object { $_ })
    }
    $expFull = @($case.expected_codes | ForEach-Object { Strip-CodeSuffix $_ })

    $predStem = @($predFull | ForEach-Object { Get-Stem $_ } | Sort-Object -Unique)
    $expStem  = @($expFull  | ForEach-Object { Get-Stem $_ } | Sort-Object -Unique)

    $full = Score-Set -Predicted $predFull -Expected $expFull
    $stem = Score-Set -Predicted $predStem -Expected $expStem
    $primaryHit = ($expFull.Count -gt 0) -and ($predFull -contains $expFull[0])

    Write-Host ("  expected: {0}" -f ($expFull -join ', '))
    Write-Host ("  predicted: {0}" -f ($predFull -join ', '))
    Write-Host ("  full  F1={0:N2}  3-stem F1={1:N2}  exact={2}  primary={3}  {4:N1}s" `
        -f $full.F1, $stem.F1, $full.Exact, $primaryHit, $sw.Elapsed.TotalSeconds) -ForegroundColor Green

    $results.Add([pscustomobject]@{
        id          = $case.id
        category    = $case.category
        ok          = $true
        expected    = $expFull
        predicted   = $predFull
        full        = $full
        stem        = $stem
        primaryHit  = $primaryHit
        durationSec = [math]::Round($sw.Elapsed.TotalSeconds, 2)
    })
    Start-Sleep -Milliseconds $DelayMs
}

$ok = $results | Where-Object { $_.ok }
$n = $ok.Count
if ($n -eq 0) { throw "No successful classifications to summarize." }

function Avg($values) { if ($values.Count) { ($values | Measure-Object -Average).Average } else { 0 } }

$summary = [pscustomobject]@{
    system           = $System
    baseUrl          = $BaseUrl
    goldFile         = (Resolve-Path $GoldFile).Path
    timestamp        = (Get-Date).ToString('o')
    cases            = $cases.Count
    succeeded        = $n
    exactSetMatch    = ($ok | Where-Object { $_.full.Exact }).Count
    primaryHit       = ($ok | Where-Object { $_.primaryHit }).Count
    avgPrecisionFull = [math]::Round((Avg ($ok | ForEach-Object { $_.full.Precision })), 3)
    avgRecallFull    = [math]::Round((Avg ($ok | ForEach-Object { $_.full.Recall })),    3)
    avgF1Full        = [math]::Round((Avg ($ok | ForEach-Object { $_.full.F1 })),        3)
    avgPrecisionStem = [math]::Round((Avg ($ok | ForEach-Object { $_.stem.Precision })), 3)
    avgRecallStem    = [math]::Round((Avg ($ok | ForEach-Object { $_.stem.Recall })),    3)
    avgF1Stem        = [math]::Round((Avg ($ok | ForEach-Object { $_.stem.F1 })),        3)
    avgDurationSec   = [math]::Round((Avg ($ok | ForEach-Object { $_.durationSec })),    2)
}

Write-Host "`n=== Summary ($System) ===" -ForegroundColor Cyan
$summary | Format-List

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$jsonPath = Join-Path $ReportDir "eval-$System-$stamp.json"
$mdPath   = Join-Path $ReportDir "eval-$System-$stamp.md"

$payload = [pscustomobject]@{ summary = $summary; results = $results }
$payload | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath -Encoding UTF8

$md = New-Object System.Text.StringBuilder
[void]$md.AppendLine("# Eval report — $System")
[void]$md.AppendLine("")
[void]$md.AppendLine("- Timestamp: $($summary.timestamp)")
[void]$md.AppendLine("- Base URL: $($summary.baseUrl)")
[void]$md.AppendLine("- Gold file: ``$($summary.goldFile)``")
[void]$md.AppendLine("- Cases: $($summary.cases)  /  Succeeded: $($summary.succeeded)")
[void]$md.AppendLine("")
[void]$md.AppendLine("## Aggregate metrics")
[void]$md.AppendLine("")
[void]$md.AppendLine("| Metric | Full code | 3-char stem |")
[void]$md.AppendLine("|---|---:|---:|")
[void]$md.AppendLine("| Avg Precision | $($summary.avgPrecisionFull) | $($summary.avgPrecisionStem) |")
[void]$md.AppendLine("| Avg Recall    | $($summary.avgRecallFull)    | $($summary.avgRecallStem)    |")
[void]$md.AppendLine("| Avg F1        | $($summary.avgF1Full)        | $($summary.avgF1Stem)        |")
[void]$md.AppendLine("")
[void]$md.AppendLine("- Exact set match: **$($summary.exactSetMatch) / $n**")
[void]$md.AppendLine("- Primary-code hit: **$($summary.primaryHit) / $n**")
[void]$md.AppendLine("- Avg duration: $($summary.avgDurationSec) s")
[void]$md.AppendLine("")
[void]$md.AppendLine("## Per-case results")
[void]$md.AppendLine("")
[void]$md.AppendLine("| ID | Category | Expected | Predicted | F1 (full) | F1 (3) | Exact | Primary |")
[void]$md.AppendLine("|---|---|---|---|---:|---:|:---:|:---:|")
foreach ($r in $ok) {
    $exp = ($r.expected -join ', ')
    $prd = ($r.predicted -join ', ')
    [void]$md.AppendLine(("| {0} | {1} | {2} | {3} | {4:N2} | {5:N2} | {6} | {7} |" -f `
        $r.id, $r.category, $exp, $prd, $r.full.F1, $r.stem.F1,
        ($(if ($r.full.Exact) { '✔' } else { '·' })),
        ($(if ($r.primaryHit) { '✔' } else { '·' }))))
}

Set-Content -Path $mdPath -Value $md.ToString() -Encoding UTF8

Write-Host "`nWrote:" -ForegroundColor Cyan
Write-Host "  $jsonPath"
Write-Host "  $mdPath"
