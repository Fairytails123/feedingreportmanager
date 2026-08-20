[CmdletBinding()]
param(
  [string]$ResultsFile
)

function Test-FtbHasProperty {
  param(
    $Object,
    [string]$Name
  )

  if ($null -eq $Object) {
    return $false
  }
  if ($Object -is [Collections.IDictionary]) {
    return $Object.Contains($Name)
  }
  return $null -ne $Object.PSObject.Properties[$Name]
}

function Get-FtbProperty {
  param(
    $Object,
    [string]$Name
  )

  if ($Object -is [Collections.IDictionary]) {
    return $Object[$Name]
  }
  return $Object.PSObject.Properties[$Name].Value
}

function Test-FtbEqual {
  param(
    $Actual,
    $Expected
  )

  $actualJson = $Actual | ConvertTo-Json -Depth 50 -Compress
  $expectedJson = $Expected | ConvertTo-Json -Depth 50 -Compress
  return $actualJson -ceq $expectedJson
}

function Test-FtbResults {
  param($resultsMap)

  $failures = 0
  $oraclePath = Join-Path $PSScriptRoot 'fixtures\expected_scenarios.json'
  try {
    $oracle = [IO.File]::ReadAllText($oraclePath) | ConvertFrom-Json
  } catch {
    return 200
  }

  if ($null -eq $resultsMap) {
    return 200
  }

  if ($resultsMap -is [Collections.IDictionary]) {
    $scenarios = @($resultsMap.GetEnumerator() | ForEach-Object {
      [pscustomobject]@{ Name = [string]$_.Key; Value = $_.Value }
    })
  } else {
    $scenarios = @($resultsMap.PSObject.Properties | ForEach-Object {
      [pscustomobject]@{ Name = $_.Name; Value = $_.Value }
    })
  }

  $machineFields = @{
    namePx = $true
    qtyPx = $true
    notesPx = $true
    medPx = $true
    listPx = $true
    tzs = $true
    clock = $true
    countdown = $true
    statusText = $true
  }

  foreach ($scenario in $scenarios) {
    $name = $scenario.Name
    $actual = $scenario.Value
    $expected = $null
    if (Test-FtbHasProperty $oracle $name) {
      $expected = Get-FtbProperty $oracle $name
    }

    $genericChecks = @(
      @{ Field = 'errors'; OracleField = 'errorsLen'; Passed = (
          (Test-FtbHasProperty $actual 'errors') -and
          (@(Get-FtbProperty $actual 'errors').Count -eq 0)
        ) },
      @{ Field = 'overflows'; OracleField = 'overflows'; Passed = (
          (Test-FtbHasProperty $actual 'overflows') -and
          ((Get-FtbProperty $actual 'overflows') -is [int]) -and
          ((Get-FtbProperty $actual 'overflows') -eq 0)
        ) },
      @{ Field = 'listOverflow'; OracleField = 'listOverflow'; Passed = (
          (Test-FtbHasProperty $actual 'listOverflow') -and
          ((Get-FtbProperty $actual 'listOverflow') -is [int]) -and
          ((Get-FtbProperty $actual 'listOverflow') -eq 0)
        ) },
      @{ Field = 'trunc'; OracleField = 'truncCount'; Passed = (
          (Test-FtbHasProperty $actual 'trunc') -and
          (Test-FtbHasProperty (Get-FtbProperty $actual 'trunc') 'count') -and
          ((Get-FtbProperty (Get-FtbProperty $actual 'trunc') 'count') -is [int]) -and
          ((Get-FtbProperty (Get-FtbProperty $actual 'trunc') 'count') -eq 0)
        ) },
      @{ Field = 'alphaCards'; OracleField = 'alphaCards'; Passed = (
          (Test-FtbHasProperty $actual 'alphaCards') -and
          ((Get-FtbProperty $actual 'alphaCards') -is [bool]) -and
          ((Get-FtbProperty $actual 'alphaCards') -eq $true)
        ) },
      @{ Field = 'alphaPrep'; OracleField = 'alphaPrep'; Passed = (
          (Test-FtbHasProperty $actual 'alphaPrep') -and
          ((Get-FtbProperty $actual 'alphaPrep') -is [bool]) -and
          ((Get-FtbProperty $actual 'alphaPrep') -eq $true)
        ) },
      @{ Field = 'alphaTom'; OracleField = 'alphaTom'; Passed = (
          (Test-FtbHasProperty $actual 'alphaTom') -and
          ((Get-FtbProperty $actual 'alphaTom') -is [bool]) -and
          ((Get-FtbProperty $actual 'alphaTom') -eq $true)
        ) },
      @{ Field = 'logoOk'; OracleField = 'logoOk'; Passed = (
          (Test-FtbHasProperty $actual 'logoOk') -and
          ((Get-FtbProperty $actual 'logoOk') -is [bool]) -and
          ((Get-FtbProperty $actual 'logoOk') -eq $true)
        ) },
      @{ Field = 'loading'; OracleField = 'loading'; Passed = (
          (Test-FtbHasProperty $actual 'loading') -and
          ((Get-FtbProperty $actual 'loading') -is [bool]) -and
          ((Get-FtbProperty $actual 'loading') -eq $false)
        ) }
    )

    foreach ($check in $genericChecks) {
      $oracleFieldExcluded = $machineFields.ContainsKey($check.OracleField) -or
        $check.OracleField -match '(?i)(date|checkin|checkout|lastupdated)'
      $carriedByOracle = ($null -ne $expected) -and
        (-not $oracleFieldExcluded) -and
        (Test-FtbHasProperty $expected $check.OracleField)
      if ((-not $carriedByOracle) -and (-not $check.Passed)) {
        $failures++
      }
    }

    if ($null -ne $expected) {
      foreach ($expectedProperty in $expected.PSObject.Properties) {
        $field = $expectedProperty.Name
        if ($machineFields.ContainsKey($field) -or
            $field -match '(?i)(date|checkin|checkout|lastupdated)') {
          continue
        }

        $matched = $false
        if ($field -eq 'errorsLen') {
          $matched = (Test-FtbHasProperty $actual 'errors') -and
            (@(Get-FtbProperty $actual 'errors').Count -eq [int]$expectedProperty.Value)
        } elseif ($field -eq 'truncCount') {
          $matched = (Test-FtbHasProperty $actual 'trunc') -and
            (Test-FtbHasProperty (Get-FtbProperty $actual 'trunc') 'count') -and
            ((Get-FtbProperty (Get-FtbProperty $actual 'trunc') 'count') -eq [int]$expectedProperty.Value)
        } elseif ($field -eq 'xssTextPrefix') {
          $matched = (Test-FtbHasProperty $actual 'xssText') -and
            ((Get-FtbProperty $actual 'xssText') -is [string]) -and
            ((Get-FtbProperty $actual 'xssText').StartsWith([string]$expectedProperty.Value))
        } elseif (Test-FtbHasProperty $actual $field) {
          $matched = Test-FtbEqual (Get-FtbProperty $actual $field) $expectedProperty.Value
        }

        if (-not $matched) {
          $failures++
        }
      }
    }

    if ($failures -ge 200) {
      return 200
    }
  }

  return [Math]::Min(200, $failures)
}

if ($MyInvocation.InvocationName -eq '.') {
  return
}

if ([string]::IsNullOrWhiteSpace($ResultsFile)) {
  exit 199
}

try {
  $standaloneResults = [IO.File]::ReadAllText($ResultsFile) | ConvertFrom-Json
} catch {
  exit 199
}

try {
  $standaloneFailures = Test-FtbResults $standaloneResults
} catch {
  exit 199
}
exit [Math]::Min(200, [int]$standaloneFailures)
