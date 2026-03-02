param(
    [string]$InstallDir = "$env:USERPROFILE\.claude-utils"
)

$repo = "https://github.com/nebelwolfi/claude-utils.git"

# When invoked via iex/irm, $PSScriptRoot is empty — clone the repo first
if (-not $PSScriptRoot -or $PSScriptRoot -eq "") {
    Write-Host "Cloning claude repo to $InstallDir..."
    if (Test-Path $InstallDir) {
        Write-Host "Directory exists, pulling latest..."
        Push-Location $InstallDir
        git fetch origin --quiet
        git reset --hard origin/master --quiet
        Pop-Location
    } else {
        git clone $repo $InstallDir --quiet
    }
    $repoRoot = $InstallDir
} else {
    $repoRoot = $PSScriptRoot
}

Get-ChildItem -Path $repoRoot -Directory | ForEach-Object {
    $mcpDir = $_.FullName
    $mcpName = $_.Name

    $pkg = Join-Path $mcpDir "package.json"
    if (-not (Test-Path $pkg)) {
        Write-Warning "Skipping $mcpName — no package.json found"
        return
    }

    # Install dependencies and build (always, to pick up source changes)
    Write-Host "Installing/building $mcpName..."
    Push-Location $mcpDir
    npm install --silent
    Pop-Location

    # Resolve entry point after build
    $json = Get-Content $pkg -Raw | ConvertFrom-Json
    $main = if ($json.main) { $json.main } else { "index.js" }
    $entryPoint = Join-Path $mcpDir $main

    if (-not (Test-Path $entryPoint)) {
        Write-Warning "Skipping $mcpName — entry point not found: $entryPoint"
        return
    }

    Write-Host "Registering MCP server: $mcpName -> $entryPoint"
    claude mcp remove --scope user $mcpName 2>$null
    claude mcp add --scope user $mcpName node $entryPoint
}


# Install Ralph-Loop globally via PowerShell profile
$ralphScript = Join-Path $repoRoot "ralph.ps1"
if (Test-Path $ralphScript) {
    $profileDir = Split-Path $PROFILE -Parent
    if (-not (Test-Path $profileDir)) {
        New-Item -Path $profileDir -ItemType Directory -Force | Out-Null
    }
    if (-not (Test-Path $PROFILE)) {
        New-Item $PROFILE -ItemType File -Force | Out-Null
    }
    $dotSource = ". `"$ralphScript`""
    $profileContent = if (Test-Path $PROFILE) { Get-Content $PROFILE -Raw } else { "" }
    if (-not $profileContent -or -not $profileContent.Contains($ralphScript)) {
        Add-Content $PROFILE "`n$dotSource"
        Write-Host "Registered Ralph-Loop in PowerShell profile ($PROFILE)."
    } else {
        Write-Host "Ralph-Loop already registered in profile."
    }
} else {
    Write-Warning "ralph.ps1 not found in $repoRoot — skipping Ralph-Loop install"
}

Write-Host 'Reload your shell: . "$PROFILE"'
