function Ralph-Loop {
param(
    [Parameter(Mandatory=$false)]
    [int]$Workers = 3,

    [Parameter(Mandatory=$false)]
    [int]$IterationsPerWorker = 10,

    [Parameter(Mandatory=$false)]
    [switch]$SkipBuild,

    [Parameter(Mandatory=$false)]
    [switch]$Cleanup,

    [Parameter(Mandatory=$false)]
    [switch]$MergeOnly,

    [Parameter(Mandatory=$false)]
    [string]$BaseBranch,

    [Parameter(Mandatory=$false)]
    [string]$ProjectDir = (Get-Location).Path
)

$ErrorActionPreference = 'Continue'
$MAIN_REPO = (git -C $ProjectDir rev-parse --show-toplevel) -replace '\\', '/'
$env:KANBAN_ROOT = $MAIN_REPO

# Auto-detect default branch if not specified
if (-not $BaseBranch) {
    $BaseBranch = git -C $MAIN_REPO symbolic-ref --short HEAD 2>$null
    if (-not $BaseBranch) { $BaseBranch = "main" }
}
$WORKTREE_ROOT = "$MAIN_REPO/.ralph-worktrees"
$LOG_DIR = "$WORKTREE_ROOT/logs"

# Discover submodules from .gitmodules
$SUBMODULES = git -C $MAIN_REPO config --file .gitmodules --get-regexp '^submodule\..*\.path$' |
    ForEach-Object { ($_ -split ' ', 2)[1] }

# Track claimed tasks for cleanup
$script:claimedTasks = @{}
$script:claimedSubTasks = @{}
$script:completedTasks = @{}

# ============================================================
# Logging
# ============================================================

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "HH:mm:ss"
    $color = switch ($Level) {
        "ERROR" { "Red" }
        "WARN"  { "Yellow" }
        "OK"    { "Green" }
        default { "Cyan" }
    }
    Write-Host "[$timestamp] " -NoNewline -ForegroundColor DarkGray
    Write-Host $Message -ForegroundColor $color
}

function Ensure-UnionMergeForProgressTxt {
    $gitattributes = "$MAIN_REPO/.gitattributes"
    $unionRule = "progress.txt merge=union"
    $needsCommit = $false
    if (Test-Path $gitattributes) {
        $content = Get-Content $gitattributes -Raw
        if ($content -notmatch 'progress\.txt\s+merge=union') {
            Add-Content $gitattributes "`n$unionRule"
            $needsCommit = $true
        }
    } else {
        Set-Content $gitattributes $unionRule
        $needsCommit = $true
    }
    if ($needsCommit) {
        git -C $MAIN_REPO add .gitattributes 2>$null
        git -C $MAIN_REPO commit -m "chore: add union merge strategy for progress.txt" 2>$null
        git -C $MAIN_REPO push origin $BaseBranch 2>$null
        Write-Log "Added .gitattributes with union merge for progress.txt" "OK"
    }
}

function Stop-AllWorkerProcesses {
    # Kill claude/node processes spawned by our worktrees (not user's own sessions)
    $worktreePattern = [regex]::Escape($WORKTREE_ROOT)
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine -match $worktreePattern } |
        Where-Object { $_.Name -match '^(claude|node)' } |
        ForEach-Object {
            Write-Log "  Killing orphaned process: $($_.Name) (PID $($_.ProcessId))"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
}

# ============================================================
# Worktree Lifecycle
# ============================================================

function New-RalphWorktree {
    param([int]$WorkerId)

    $worktreePath = "$WORKTREE_ROOT/worker-$WorkerId"
    $branchName = "ralph/worker-$WorkerId"

    # Remove stale worktree/branch if they exist
    if (Test-Path $worktreePath) {
        Write-Log "Removing stale worktree for worker $WorkerId" "WARN"
        $null = git -C $MAIN_REPO worktree remove $worktreePath --force 2>$null
    }
    $null = git -C $MAIN_REPO branch -D $branchName 2>$null

    # Create worktree with a new branch from BaseBranch
    $null = git -C $MAIN_REPO worktree add $worktreePath -b $branchName $BaseBranch 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $worktreePath)) {
        Write-Log "Failed to create worktree for worker $WorkerId (branch $BaseBranch may not exist)" "ERROR"
        return $null
    }
    Write-Log "Created worktree: $worktreePath (branch: $branchName)" "OK"

    return $worktreePath
}

function Initialize-Submodules {
    param([string]$WorktreePath)

    foreach ($sub in $SUBMODULES) {
        $dest = "$WorktreePath/$sub"
        $src = "$MAIN_REPO/$sub"

        # Remove the empty directory the worktree created (submodule placeholder)
        if (Test-Path $dest) {
            Remove-Item $dest -Recurse -Force
        }

        # Ensure parent directory exists
        $parentDir = Split-Path $dest -Parent
        if (-not (Test-Path $parentDir)) {
            New-Item -Path $parentDir -ItemType Directory -Force | Out-Null
        }

        # Clone from local repo (fast, uses hardlinks)
        Write-Log "  Cloning submodule: $sub"
        $cloneOutput = git clone --local $src $dest 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log "  Failed to clone $sub : $cloneOutput" "ERROR"
            throw "Submodule clone failed: $sub"
        }

        # Copy the real remote URL so pushes go to GitHub, not the local clone
        $realRemote = git -C $src remote get-url origin 2>$null
        if ($realRemote -and $realRemote -ne $src) {
            git -C $dest remote set-url origin $realRemote 2>$null | Out-Null
        }
    }

    Write-Log "Submodules initialized for $WorktreePath" "OK"
}

function Patch-ClaudeMD {
    param([string]$WorktreePath)

    $claudeMdPath = "$WorktreePath/CLAUDE.md"
    if (-not (Test-Path $claudeMdPath)) {
        Write-Log "No CLAUDE.md found in worktree, skipping patch" "WARN"
        return
    }

    $content = Get-Content $claudeMdPath -Raw
    # Replace main repo paths (forward and backslash variants) with worktree path
    $escaped = [regex]::Escape($MAIN_REPO)
    $content = $content -replace "$escaped(?![/\\]\.|[/\\]ralph)", $WorktreePath
    $backslashMain = $MAIN_REPO -replace '/', '\'
    $escapedBackslash = [regex]::Escape($backslashMain)
    $content = $content -replace "$escapedBackslash(?![/\\]\.|[/\\]ralph)", ($WorktreePath -replace '/', '\')

    Set-Content $claudeMdPath -Value $content -NoNewline
    Write-Log "  Patched CLAUDE.md paths"
}

function Configure-WorktreeBuild {
    param([string]$WorktreePath)

    if (-not (Test-Path "$WorktreePath/CMakeLists.txt")) {
        Write-Log "  No CMakeLists.txt found, skipping cmake configure"
        return $true
    }

    $buildDir = "$WorktreePath/cmake-build-debug"

    # Read cmake cache variables from the main repo's build dir and remap paths
    $cmakeDefines = @()
    $mainBuildCache = "$MAIN_REPO/cmake-build-debug/CMakeCache.txt"
    if (Test-Path $mainBuildCache) {
        $escapedMain = [regex]::Escape($MAIN_REPO)
        Get-Content $mainBuildCache | Where-Object { $_ -match '^([A-Za-z_][A-Za-z0-9_]*):([A-Z]+)=(.+)$' } |
            ForEach-Object {
                if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*):([A-Z]+)=(.+)$') {
                    $name, $type, $val = $matches[1], $matches[2], $matches[3]
                    if ($val -match $escapedMain) {
                        $remapped = $val -replace $escapedMain, $WorktreePath
                        $cmakeDefines += "-D${name}:${type}=$remapped"
                    }
                }
            }
    }

    Write-Log "  Configuring cmake build..."
    $cmakeOutput = cmake `
        -DCMAKE_BUILD_TYPE=Debug `
        -DCMAKE_MAKE_PROGRAM=ninja `
        -DCMAKE_C_COMPILER=clang `
        -DCMAKE_CXX_COMPILER=clang++ `
        @cmakeDefines `
        -G Ninja `
        -S "$WorktreePath" `
        -B "$buildDir" 2>&1
    $cmakeExit = $LASTEXITCODE

    if ($cmakeExit -ne 0) {
        Write-Log "cmake configure failed for $WorktreePath" "ERROR"
        Write-Log "  $($cmakeOutput | Select-Object -Last 3)" "ERROR"
        return $false
    }

    Write-Log "  cmake configured successfully" "OK"
    return $true
}

function Remove-RalphWorktree {
    param([int]$WorkerId)

    $worktreePath = "$WORKTREE_ROOT/worker-$WorkerId"

    if (Test-Path $worktreePath) {
        Write-Log "Removing worktree for worker $WorkerId"
        git -C $MAIN_REPO worktree remove $worktreePath --force 2>$null
    }
    # Keep the branch - PRs reference it
}

function New-MergeWorktree {
    $worktreePath = "$WORKTREE_ROOT/merge-worker"
    $branchName = "ralph/merge-worker"

    if (Test-Path $worktreePath) {
        $null = git -C $MAIN_REPO worktree remove $worktreePath --force 2>$null
    }
    $null = git -C $MAIN_REPO branch -D $branchName 2>$null

    $null = git -C $MAIN_REPO worktree add $worktreePath -b $branchName $BaseBranch 2>&1
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $worktreePath)) {
        Write-Log "Failed to create merge worktree" "ERROR"
        return $null
    }
    Write-Log "Created merge worktree: $worktreePath" "OK"

    return $worktreePath
}

function Remove-MergeWorktree {
    $worktreePath = "$WORKTREE_ROOT/merge-worker"

    if (Test-Path $worktreePath) {
        Write-Log "Removing merge worktree"
        git -C $MAIN_REPO worktree remove $worktreePath --force 2>$null
    }
    $null = git -C $MAIN_REPO branch -D "ralph/merge-worker" 2>$null
}

function Remove-AllWorktrees {
    Write-Log "Cleaning up all ralph worktrees..."

    # Find actual ralph worktrees from git
    $worktreeList = git -C $MAIN_REPO worktree list --porcelain 2>$null
    if ($worktreeList) {
        $worktreeList | ForEach-Object {
            if ($_ -match '^worktree (.+ralph-worktrees.+)') {
                $path = $matches[1]
                Write-Log "  Removing worktree: $path"
                git -C $MAIN_REPO worktree remove $path --force 2>$null | Out-Null
            }
        }
    }

    # Delete ralph branches
    $branches = git -C $MAIN_REPO branch --list "ralph/*" 2>$null
    if ($branches) {
        $branches | ForEach-Object {
            $branch = $_.Trim().TrimStart('* ')
            git -C $MAIN_REPO branch -D $branch 2>$null | Out-Null
        }
    }

    if (Test-Path $WORKTREE_ROOT) {
        Remove-Item $WORKTREE_ROOT -Recurse -Force -ErrorAction SilentlyContinue
    }

    git -C $MAIN_REPO worktree prune 2>$null | Out-Null
    Write-Log "Cleanup complete" "OK"
}

function Prune-MergedRalphBranches {
    git -C $MAIN_REPO fetch origin --prune 2>&1 | Out-Null

    $pruned = 0

    $remoteBranches = git -C $MAIN_REPO ls-remote --heads origin "ralph/*" 2>$null
    if (-not $remoteBranches) { return }

    foreach ($line in @($remoteBranches)) {
        if ($line -match 'refs/heads/(ralph/.+)$') {
            $remoteBranch = $Matches[1]
            if ($remoteBranch -match '^ralph/worker-\d+$') { continue }

            $taskId = $remoteBranch -replace '^ralph/', ''
            if ($script:claimedTasks.ContainsKey($taskId)) { continue }

            # Check 1: git cherry - all commits already in master by patch content
            $unmerged = git -C $MAIN_REPO cherry "origin/$BaseBranch" "origin/$remoteBranch" 2>$null | Select-String '^\+'

            # Check 2: if cherry says unmerged, check PR state as fallback
            # (rebase merges can change patch IDs, making cherry unreliable)
            $prState = $null
            if ($unmerged) {
                $prState = gh pr view $remoteBranch --json state --jq .state 2>$null
            }

            if (-not $unmerged -or $prState -ieq "MERGED") {
                git -C $MAIN_REPO push origin --delete $remoteBranch 2>&1 | Out-Null
                if ($LASTEXITCODE -eq 0) {
                    $reason = if (-not $unmerged) { "cherry-clean" } else { "PR merged" }
                    Write-Log "  Pruned remote branch: $remoteBranch ($reason)" "OK"
                    $pruned++
                }
            }
        }
    }

    if ($pruned -gt 0) {
        Write-Log "Pruned $pruned merged ralph branch(es)" "OK"
    }
}

# ============================================================
# Task Coordination
# ============================================================

function Get-ColumnTaskItems {
    param($ColumnTasks)
    if ($null -eq $ColumnTasks) { return @() }
    if ($ColumnTasks -is [System.Array]) { return $ColumnTasks }
    return @($ColumnTasks)
}

function Get-TaskId {
    param($Task)
    if ($null -eq $Task) { return $null }
    if ($Task -is [string]) { return $Task }
    if ($Task.PSObject.Properties["id"]) { return [string]$Task.id }
    return [string]$Task
}

function Test-IsKanbnPath {
    param([string]$RelativePath)

    if (-not $RelativePath) { return $false }
    $normalized = ($RelativePath -replace '\\', '/').Trim()
    return ($normalized -eq ".kanbn" -or $normalized.StartsWith(".kanbn/"))
}

function Test-HasNonKanbnChangesInRange {
    param([string]$RepoPath, [string]$RangeSpec)

    Push-Location $RepoPath
    try {
        $changedFiles = git diff --name-only $RangeSpec 2>$null
        if (-not $changedFiles) { return $false }

        foreach ($changedFile in @($changedFiles)) {
            if (-not (Test-IsKanbnPath -RelativePath ([string]$changedFile))) {
                return $true
            }
        }

        return $false
    }
    finally {
        Pop-Location
    }
}

function Test-ConflictMarkers {
    param([string]$RepoPath)

    Push-Location $RepoPath
    try {
        # Check committed files (HEAD) including submodules
        $markers = git grep --recurse-submodules -l -E '^<{7} |^={7}$|^>{7} ' HEAD -- 2>$null
        if ($LASTEXITCODE -eq 0 -and $markers) { return $true }

        # Also check tracked files in working tree (catches uncommitted marker files)
        $wtMarkers = git grep --recurse-submodules -l -E '^<{7} |^={7}$|^>{7} ' -- 2>$null
        return ($LASTEXITCODE -eq 0 -and $wtMarkers)
    }
    finally {
        Pop-Location
    }
}

function Get-ColumnIndex {
    param($Board, [string]$ColumnName)

    if (-not $Board -or -not $Board.headings) { return -1 }
    for ($i = 0; $i -lt $Board.headings.Count; $i++) {
        $heading = $Board.headings[$i]
        if ($heading -and $heading.PSObject.Properties["name"] -and $heading.name -ieq $ColumnName) {
            return $i
        }
    }

    return -1
}

function Parse-KanbanFrontmatter {
    param([string]$Content)
    $fm = @{}
    $body = $Content
    if ($Content -match '(?s)^---\r?\n(.*?)\r?\n---\r?\n?(.*)$') {
        $fmBlock = $Matches[1]
        $body = $Matches[2].TrimStart()
        $fmLines = $fmBlock -split "`n"
        $i = 0
        while ($i -lt $fmLines.Count) {
            $ln = $fmLines[$i].TrimEnd()
            if (-not $ln) { $i++; continue }
            $ci = $ln.IndexOf(':')
            if ($ci -lt 0) { $i++; continue }
            $key = $ln.Substring(0, $ci).Trim()
            $val = $ln.Substring($ci + 1).Trim()
            if ($val -eq '' -and ($i + 1) -lt $fmLines.Count -and $fmLines[$i + 1] -match '^\s+-') {
                $arr = @()
                $i++
                while ($i -lt $fmLines.Count -and $fmLines[$i] -match '^\s+-') {
                    $arr += ($fmLines[$i] -replace '^\s+-\s*', '').Trim().Trim("'""")
                    $i++
                }
                $fm[$key] = $arr
                continue
            }
            if ($val -match '^\[(.*)\]$') {
                $inner = $Matches[1]
                $fm[$key] = if ($inner) { @($inner -split ',' | ForEach-Object { $_.Trim().Trim("'""") } | Where-Object { $_ }) } else { @() }
            } else {
                $fm[$key] = $val.Trim("'""")
            }
            $i++
        }
    }
    return @{ frontmatter = $fm; body = $body }
}

function Read-KanbanTaskDirect {
    param([string]$RepoPath = $MAIN_REPO, [string]$TaskId, [string]$Column = "")
    $taskPath = "$RepoPath/.kanbn/tasks/$TaskId.md"
    if (-not (Test-Path $taskPath)) { return $null }
    try { $raw = [System.IO.File]::ReadAllText($taskPath, [System.Text.Encoding]::UTF8) } catch { return $null }
    $parsed = Parse-KanbanFrontmatter -Content $raw
    $fm = $parsed.frontmatter
    $body = $parsed.body
    $title = $TaskId
    if ($body -match '(?m)^# (.+)$') { $title = $Matches[1].Trim() }
    $stripped = ($body -replace '(?s)\n---\r?\n.*?\r?\n---', '')
    $stripped = ($stripped -replace '(?m)^# .+\n*', '').Trim()
    $relations = @()
    if ($stripped -match '(?s)(## Relations\r?\n)(.*?)(?=\n## |\s*$)') {
        foreach ($line in ($Matches[2] -split "`n")) {
            $relText = $null
            if ($line -match '^- \[([^\]]+)\]\([^)]+\)$') { $relText = $Matches[1].Trim() }
            elseif ($line -match '^- \[([^\]]+)\]$') { $relText = $Matches[1].Trim() }
            if ($relText) {
                $parts = $relText -split '\s+', 2
                if ($parts.Count -gt 1) {
                    $relations += [PSCustomObject]@{ type = $parts[0]; taskId = $parts[1] }
                } else {
                    $relations += [PSCustomObject]@{ type = ""; taskId = $parts[0] }
                }
            }
        }
    }
    $subTasks = @()
    if ($stripped -match '(?s)(## Sub-tasks\r?\n)(.*?)(?=\n## |\s*$)') {
        foreach ($line in ($Matches[2] -split "`n")) {
            if ($line -match '^- \[([ xX])\] (.+)$') {
                $subTasks += [PSCustomObject]@{ text = $Matches[2].Trim(); completed = ($Matches[1] -ne ' ') }
            }
        }
    }
    $tags = @()
    if ($fm.ContainsKey('tags')) {
        if ($fm['tags'] -is [array]) { $tags = $fm['tags'] } elseif ($fm['tags']) { $tags = @($fm['tags']) }
    }
    $priority = if ($fm.ContainsKey('priority') -and $fm['priority']) { $fm['priority'] } else { "medium" }
    return [PSCustomObject]@{
        id = $TaskId; title = $title; subTasks = $subTasks; relations = $relations
        column = $Column; tags = $tags; priority = $priority
    }
}

function Read-KanbanIndex {
    param([string]$RepoPath = $MAIN_REPO)
    $indexPath = "$RepoPath/.kanbn/index.md"
    if (-not (Test-Path $indexPath)) { return $null }
    try { $raw = [System.IO.File]::ReadAllText($indexPath, [System.Text.Encoding]::UTF8) } catch { return $null }
    $parsed = Parse-KanbanFrontmatter -Content $raw
    $fm = $parsed.frontmatter
    $body = $parsed.body
    $boardName = ""
    if ($body -match '(?m)^# (.+)$') { $boardName = $Matches[1].Trim() }
    $startedCols = if ($fm.ContainsKey('startedColumns') -and $fm['startedColumns'] -is [array]) { $fm['startedColumns'] } else { @("In Progress") }
    $completedCols = if ($fm.ContainsKey('completedColumns') -and $fm['completedColumns'] -is [array]) { $fm['completedColumns'] } else { @("Done") }
    $columns = @()
    $tasksByColumn = @{}
    $h2Matches = [regex]::Matches($body, '(?m)^## (.+)$')
    for ($i = 0; $i -lt $h2Matches.Count; $i++) {
        $colName = $h2Matches[$i].Groups[1].Value.Trim()
        $columns += $colName
        $tasksByColumn[$colName] = @()
        $sectionStart = $h2Matches[$i].Index + $h2Matches[$i].Length
        $sectionEnd = if (($i + 1) -lt $h2Matches.Count) { $h2Matches[$i + 1].Index } else { $body.Length }
        $section = $body.Substring($sectionStart, $sectionEnd - $sectionStart)
        $linkMatches = [regex]::Matches($section, '(?m)^- \[([^\]]+)\]\(tasks/[^)]+\.md\)')
        foreach ($lm in $linkMatches) { $tasksByColumn[$colName] += $lm.Groups[1].Value.Trim() }
    }
    return @{
        name = $boardName; columns = $columns; tasksByColumn = $tasksByColumn
        startedColumns = $startedCols; completedColumns = $completedCols
    }
}

function Write-KanbanIndex {
    param([string]$RepoPath = $MAIN_REPO, $Index)
    $indexPath = "$RepoPath/.kanbn/index.md"
    $fmStr = ""
    if ($Index.startedColumns -and $Index.startedColumns.Count -gt 0) {
        $fmStr += "startedColumns:`n"
        foreach ($sc in $Index.startedColumns) { $fmStr += "  - $sc`n" }
    }
    if ($Index.completedColumns -and $Index.completedColumns.Count -gt 0) {
        $fmStr += "completedColumns:`n"
        foreach ($cc in $Index.completedColumns) { $fmStr += "  - $cc`n" }
    }
    $newContent = "---`n${fmStr}---`n`n# $($Index.name)`n"
    foreach ($col in $Index.columns) {
        $tasks = $Index.tasksByColumn[$col]
        $newContent += "`n## $col`n"
        if ($tasks -and $tasks.Count -gt 0) {
            $newContent += "`n"
            foreach ($tid in $tasks) { $newContent += "- [$tid](tasks/$tid.md)`n" }
        }
    }
    [System.IO.File]::WriteAllText($indexPath, $newContent, [System.Text.Encoding]::UTF8)
}

function Move-KanbanTask {
    param([string]$RepoPath = $MAIN_REPO, [string]$TaskId, [string]$Column)
    $index = Read-KanbanIndex -RepoPath $RepoPath
    if (-not $index) { return $false }
    if ($Column -notin $index.columns) { return $false }
    foreach ($col in $index.columns) {
        $index.tasksByColumn[$col] = @($index.tasksByColumn[$col] | Where-Object { $_ -ne $TaskId })
    }
    $index.tasksByColumn[$Column] += $TaskId
    Write-KanbanIndex -RepoPath $RepoPath -Index $index
    $taskPath = "$RepoPath/.kanbn/tasks/$TaskId.md"
    if (Test-Path $taskPath) {
        try {
            $taskRaw = [System.IO.File]::ReadAllText($taskPath, [System.Text.Encoding]::UTF8)
            if ($taskRaw -match '(?s)^---\r?\n(.*?)\r?\n---') {
                $fmBlock = $Matches[1]
                $newFm = $fmBlock
                $now = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                if ($newFm -match '(?m)^updated:.*$') {
                    $newFm = $newFm -replace '(?m)^updated:.*$', "updated: $now"
                } else {
                    $newFm += "`nupdated: $now"
                }
                if ($Column -in $index.startedColumns -and $newFm -notmatch '(?m)^started:') {
                    $newFm += "`nstarted: $now"
                }
                if ($Column -in $index.completedColumns -and $newFm -notmatch '(?m)^completed:') {
                    $newFm += "`ncompleted: $now"
                }
                if ($newFm -ne $fmBlock) {
                    $taskRaw = $taskRaw.Remove($Matches.Index, $Matches.Length).Insert($Matches.Index, "---`n$newFm`n---")
                    [System.IO.File]::WriteAllText($taskPath, $taskRaw, [System.Text.Encoding]::UTF8)
                }
            }
        } catch {}
    }
    return $true
}

function Get-BoardJson {
    param([string]$RepoPath = $MAIN_REPO)
    $index = Read-KanbanIndex -RepoPath $RepoPath
    if (-not $index) { return $null }
    $headings = @()
    $colArrays = @()
    foreach ($colName in $index.columns) {
        $headings += [PSCustomObject]@{ name = $colName }
        $taskObjs = @()
        foreach ($tid in $index.tasksByColumn[$colName]) {
            $taskObj = Read-KanbanTaskDirect -RepoPath $RepoPath -TaskId $tid -Column $colName
            if ($taskObj) { $taskObjs += $taskObj }
            else { $taskObjs += [PSCustomObject]@{ id = $tid; column = $colName; subTasks = @(); relations = @(); tags = @(); priority = "medium" } }
        }
        $colArrays += ,@($taskObjs)
    }
    return [PSCustomObject]@{
        headings = $headings
        lanes = @([PSCustomObject]@{ columns = $colArrays })
        startedColumns = $index.startedColumns
        completedColumns = $index.completedColumns
    }
}

function Get-TaskJson {
    param([string]$RepoPath, [string]$TaskId)
    if (-not $TaskId) { return $null }
    $taskObj = Read-KanbanTaskDirect -RepoPath $RepoPath -TaskId $TaskId
    if ($taskObj) { return $taskObj }
    $board = Get-BoardJson -RepoPath $RepoPath
    if (-not $board) { return $null }
    foreach ($lane in $board.lanes) {
        for ($c = 0; $c -lt $lane.columns.Count; $c++) {
            foreach ($task in (Get-ColumnTaskItems -ColumnTasks $lane.columns[$c])) {
                if ((Get-TaskId -Task $task) -eq $TaskId) { return $task }
            }
        }
    }
    return $null
}

function Get-FirstIncompleteSubTask {
    param($Task)

    if (-not $Task -or -not $Task.PSObject.Properties["subTasks"] -or -not $Task.subTasks) {
        return $null
    }

    foreach ($subTask in $Task.subTasks) {
        if ($subTask.PSObject.Properties["completed"] -and -not $subTask.completed) {
            return [string]$subTask.text
        }
    }

    return $null
}

function Test-AllSubTasksComplete {
    param($Task)

    if (-not $Task -or -not $Task.PSObject.Properties["subTasks"] -or -not $Task.subTasks) {
        return $true
    }

    foreach ($subTask in $Task.subTasks) {
        if ($subTask.PSObject.Properties["completed"] -and -not $subTask.completed) {
            return $false
        }
    }

    return $true
}

function Test-SubTaskComplete {
    param($Task, [string]$SubTaskText)

    if (-not $SubTaskText -or -not $Task -or -not $Task.PSObject.Properties["subTasks"] -or -not $Task.subTasks) {
        return $false
    }

    foreach ($subTask in $Task.subTasks) {
        $text = if ($subTask.PSObject.Properties["text"]) { [string]$subTask.text } else { [string]$subTask }
        if ($text -eq $SubTaskText) {
            if ($subTask.PSObject.Properties["completed"]) {
                return [bool]$subTask.completed
            }
            return $false
        }
    }

    return $false
}

function Complete-SubTaskInRepo {
    param([string]$RepoPath, [string]$TaskId, [string]$SubTaskText)

    if (-not $SubTaskText) { return $false }

    # Edit the task markdown directly to avoid kanbn CLI escaping issues
    # with special characters (quotes, parens, backticks, brackets)
    $taskFile = "$RepoPath/.kanbn/tasks/$TaskId.md"
    if (-not (Test-Path $taskFile)) { return $false }

    $content = [System.IO.File]::ReadAllText($taskFile, [System.Text.Encoding]::UTF8)
    $escapedText = [regex]::Escape($SubTaskText)
    $pattern = "(?m)^(\s*[-*]\s*)\[ \](\s+$escapedText\s*$)"
    $replacement = '${1}[x]${2}'

    $newContent = [regex]::Replace($content, $pattern, $replacement)
    if ($newContent -eq $content) {
        # Check if already marked complete (MCP may have done it directly via KANBAN_ROOT)
        $alreadyDone = "(?m)^(\s*[-*]\s*)\[x\](\s+$escapedText\s*$)"
        if ([regex]::IsMatch($content, $alreadyDone)) { return $true }
        return $false
    }

    [System.IO.File]::WriteAllText($taskFile, $newContent, [System.Text.Encoding]::UTF8)
    return $true
}

function Get-TaskColumn {
    param([string]$RepoPath, [string]$TaskId)

    $board = Get-BoardJson -RepoPath $RepoPath
    if (-not $board) { return $null }

    foreach ($lane in $board.lanes) {
        for ($c = 0; $c -lt $lane.columns.Count; $c++) {
            foreach ($task in (Get-ColumnTaskItems -ColumnTasks $lane.columns[$c])) {
                if ((Get-TaskId -Task $task) -eq $TaskId) {
                    if ($task.PSObject.Properties["column"] -and $task.column) {
                        return [string]$task.column
                    }
                    if ($board.headings -and $c -lt $board.headings.Count) {
                        return [string]$board.headings[$c].name
                    }
                    return $null
                }
            }
        }
    }

    return $null
}

function Release-TaskClaim {
    param([string]$TaskId)

    if (-not $TaskId) { return }
    $script:claimedTasks.Remove($TaskId) | Out-Null
    $script:claimedSubTasks.Remove($TaskId) | Out-Null
}

function Repair-DoneCardsWithIncompleteSubTasks {
    $board = Get-BoardJson -RepoPath $MAIN_REPO
    if (-not $board) { return }

    $doneIndex = Get-ColumnIndex -Board $board -ColumnName "Done"
    if ($doneIndex -lt 0) { return }

    $seen = @{}
    $repaired = 0
    foreach ($lane in $board.lanes) {
        if ($doneIndex -ge $lane.columns.Count) { continue }
        foreach ($task in (Get-ColumnTaskItems -ColumnTasks $lane.columns[$doneIndex])) {
            $taskId = Get-TaskId -Task $task
            if (-not $taskId -or $seen.ContainsKey($taskId)) { continue }
            $seen[$taskId] = $true

            $taskObj = if ($task.PSObject.Properties["subTasks"]) { $task } else { Get-TaskJson -RepoPath $MAIN_REPO -TaskId $taskId }
            if (-not (Test-AllSubTasksComplete -Task $taskObj)) {
                Move-KanbanTask -RepoPath $MAIN_REPO -TaskId $taskId -Column "In Progress" | Out-Null
                Write-Log "Moved $taskId from Done to In Progress (incomplete subtasks)" "WARN"
                $repaired++
            }
        }
    }

    if ($repaired -gt 0) {
        Write-Log "Repaired $repaired Done task(s) with incomplete subtasks" "WARN"
    }
}

function Get-CheckedOutTaskBranches {
    param(
        [int]$ExcludeWorkerId = 0,
        [hashtable]$Worktrees = @{}
    )
    $checkedOut = @{}
    foreach ($w in $Worktrees.Keys) {
        if ($w -eq $ExcludeWorkerId) { continue }
        $branch = git -C $Worktrees[$w] rev-parse --abbrev-ref HEAD 2>$null
        if ($branch -and $branch -match '^ralph/(.+)$') {
            $checkedOut[$Matches[1]] = $w
        }
    }
    return $checkedOut
}

function Get-BlockerTaskIds {
    param($TaskObj, [string]$TaskId = "", [hashtable]$DoneTasks, [hashtable]$PRTasks = @{}, [hashtable]$ReverseBlockedBy = @{})
    $ids = @()
    if ($TaskObj -and $TaskObj.PSObject.Properties["relations"] -and $TaskObj.relations) {
        foreach ($rel in $TaskObj.relations) {
            $relType = if ($rel.PSObject.Properties["type"]) { $rel.type } else { "" }
            if ($relType -imatch '^blocked|^requires') {
                $bid = $rel.taskId
                if (-not $bid) { continue }
                if ($bid -imatch '^by\s+(.+)$') { $bid = $Matches[1] }
                if (-not $DoneTasks.ContainsKey($bid) -and -not $PRTasks.ContainsKey($bid)) { $ids += $bid }
            }
        }
    }
    if ($TaskId -and $ReverseBlockedBy.ContainsKey($TaskId)) {
        foreach ($bid in $ReverseBlockedBy[$TaskId]) {
            if (-not $DoneTasks.ContainsKey($bid) -and -not $PRTasks.ContainsKey($bid) -and $bid -notin $ids) { $ids += $bid }
        }
    }
    return $ids
}

function Claim-NextTask {
    param(
        [int]$WorkerId,
        [hashtable]$Worktrees = @{}
    )

    $board = Get-BoardJson -RepoPath $MAIN_REPO
    if (-not $board) {
        Write-Log "Failed to read kanbn board" "ERROR"
        return $null
    }

    $checkedOutBranches = Get-CheckedOutTaskBranches -ExcludeWorkerId $WorkerId -Worktrees $Worktrees

    $inProgressIndex = Get-ColumnIndex -Board $board -ColumnName "In Progress"
    $todoIndex = Get-ColumnIndex -Board $board -ColumnName "Todo"
    $backlogIndex = Get-ColumnIndex -Board $board -ColumnName "Backlog"
    $doneIndex = Get-ColumnIndex -Board $board -ColumnName "Done"

    $doneTasks = @{}
    if ($doneIndex -ge 0) {
        foreach ($lane in $board.lanes) {
            if ($doneIndex -ge $lane.columns.Count) { continue }
            foreach ($t in (Get-ColumnTaskItems -ColumnTasks $lane.columns[$doneIndex])) {
                $tid = Get-TaskId -Task $t
                if ($tid) { $doneTasks[$tid] = $true }
            }
        }
    }
    foreach ($tid in $script:completedTasks.Keys) { $doneTasks[$tid] = $true }

    $prTasks = @{}
    $prBranches = gh pr list --json headRefName --jq '.[].headRefName' 2>$null
    if ($LASTEXITCODE -eq 0 -and $prBranches) {
        foreach ($br in ($prBranches -split "`n")) {
            if ($br -match '^ralph/(.+)$') { $prTasks[$Matches[1]] = $true }
        }
    }

    $candidates = [System.Collections.ArrayList]::new()
    $reverseBlockedBy = @{}
    $columnRank = 0
    foreach ($targetColumn in @($inProgressIndex, $todoIndex, $backlogIndex)) {
        if ($targetColumn -lt 0) { $columnRank++; continue }

        foreach ($lane in $board.lanes) {
            if ($targetColumn -ge $lane.columns.Count) { continue }
            foreach ($task in (Get-ColumnTaskItems -ColumnTasks $lane.columns[$targetColumn])) {
                $taskId = Get-TaskId -Task $task
                if (-not $taskId) { continue }

                $taskObj = if ($task.PSObject.Properties["relations"]) { $task } else { Get-TaskJson -RepoPath $MAIN_REPO -TaskId $taskId }

                if ($taskObj -and $taskObj.PSObject.Properties["relations"] -and $taskObj.relations) {
                    foreach ($rel in $taskObj.relations) {
                        $relType = if ($rel.PSObject.Properties["type"]) { $rel.type } else { "" }
                        if ($relType -ieq 'blocks') {
                            $tid = $rel.taskId
                            if (-not $tid) { continue }
                            if (-not $reverseBlockedBy.ContainsKey($tid)) { $reverseBlockedBy[$tid] = @() }
                            $reverseBlockedBy[$tid] += $taskId
                        }
                    }
                }

                if ($script:claimedTasks.ContainsKey($taskId)) { continue }
                if ($script:completedTasks.ContainsKey($taskId)) { continue }
                if ($checkedOutBranches.ContainsKey($taskId)) { continue }

                $candidates.Add(@{
                    TaskId     = $taskId
                    TaskObj    = $taskObj
                    ColumnRank = $columnRank
                }) | Out-Null
            }
        }
        $columnRank++
    }

    if ($candidates.Count -eq 0) { return $null }

    $isBlockingOthers = @{}
    foreach ($c in $candidates) {
        $blockerIds = Get-BlockerTaskIds -TaskObj $c.TaskObj -TaskId $c.TaskId -DoneTasks $doneTasks -PRTasks $prTasks -ReverseBlockedBy $reverseBlockedBy
        $c.IsBlocked = $blockerIds.Count -gt 0
        foreach ($bid in $blockerIds) { $isBlockingOthers[$bid] = $true }

        $c.HasPriority = $false
        if ($c.TaskObj) {
            if ($c.TaskObj.PSObject.Properties["tags"] -and $c.TaskObj.tags) {
                foreach ($tag in $c.TaskObj.tags) {
                    if ($tag -ieq "priority") { $c.HasPriority = $true; break }
                }
            }
            if ($c.TaskObj.PSObject.Properties["priority"] -and $c.TaskObj.priority -in @("high", "critical")) {
                $c.HasPriority = $true
            }
        }
    }
    foreach ($c in $candidates) { $c.IsBlocker = $isBlockingOthers.ContainsKey($c.TaskId) }

    $sorted = $candidates | Sort-Object -Property @(
        @{ Expression = { [int]$_.IsBlocked }; Descending = $false },
        @{ Expression = { [int]$_.IsBlocker }; Descending = $true },
        @{ Expression = { [int]$_.HasPriority }; Descending = $true },
        @{ Expression = { $_.ColumnRank }; Descending = $false }
    )

    $chosen = if ($sorted -is [array]) { $sorted[0] } else { $sorted }

    if ($chosen.IsBlocked) {
        $visited = @{}; $visited[$chosen.TaskId] = $true
        $frontier = [System.Collections.Queue]::new()
        foreach ($bid in (Get-BlockerTaskIds -TaskObj $chosen.TaskObj -TaskId $chosen.TaskId -DoneTasks $doneTasks -PRTasks $prTasks -ReverseBlockedBy $reverseBlockedBy)) {
            if (-not $visited.ContainsKey($bid)) { $visited[$bid] = $true; $frontier.Enqueue($bid) }
        }
        $leafCandidates = [System.Collections.ArrayList]::new()
        while ($frontier.Count -gt 0) {
            $curId = $frontier.Dequeue()
            if ($doneTasks.ContainsKey($curId)) { continue }
            if ($script:claimedTasks.ContainsKey($curId)) { continue }
            if ($script:completedTasks.ContainsKey($curId)) { continue }
            if ($checkedOutBranches.ContainsKey($curId)) { continue }
            $existing = $candidates | Where-Object { $_.TaskId -eq $curId } | Select-Object -First 1
            $curObj = if ($existing) { $existing.TaskObj } else { Get-TaskJson -RepoPath $MAIN_REPO -TaskId $curId }
            if (-not $curObj) { continue }
            $curBlockers = Get-BlockerTaskIds -TaskObj $curObj -TaskId $curId -DoneTasks $doneTasks -PRTasks $prTasks -ReverseBlockedBy $reverseBlockedBy
            if ($curBlockers.Count -eq 0) {
                $hp = $false
                if ($curObj.PSObject.Properties["tags"] -and $curObj.tags) { foreach ($t in $curObj.tags) { if ($t -ieq "priority") { $hp = $true; break } } }
                if ($curObj.PSObject.Properties["priority"] -and $curObj.priority -in @("high","critical")) { $hp = $true }
                $cr = if ($existing) { $existing.ColumnRank } else { 2 }
                $isBlkr = $isBlockingOthers.ContainsKey($curId)
                $leafCandidates.Add(@{ TaskId=$curId; TaskObj=$curObj; ColumnRank=$cr; IsBlocked=$false; HasPriority=$hp; IsBlocker=$isBlkr }) | Out-Null
            } else {
                foreach ($bid in $curBlockers) {
                    if (-not $visited.ContainsKey($bid)) { $visited[$bid] = $true; $frontier.Enqueue($bid) }
                }
            }
        }
        if ($leafCandidates.Count -gt 0) {
            $leafSorted = $leafCandidates | Sort-Object -Property @(
                @{ Expression = { [int]$_.IsBlocker }; Descending = $true },
                @{ Expression = { [int]$_.HasPriority }; Descending = $true },
                @{ Expression = { $_.ColumnRank }; Descending = $false }
            )
            $chosen = if ($leafSorted -is [array]) { $leafSorted[0] } else { $leafSorted }
            Write-Log "Worker $WorkerId resolved blocker graph -> unblocked task $($chosen.TaskId)" "INFO"
        } else {
            Write-Log "Worker $WorkerId picking blocked task $($chosen.TaskId) (no claimable unblocked blockers)" "WARN"
        }
    }

    $taskId = $chosen.TaskId
    $taskObj = $chosen.TaskObj
    $claimedSubTask = Get-FirstIncompleteSubTask -Task $taskObj

    Move-KanbanTask -RepoPath $MAIN_REPO -TaskId $taskId -Column "In Progress" | Out-Null

    $script:claimedTasks[$taskId] = $WorkerId
    if ($claimedSubTask) {
        $script:claimedSubTasks[$taskId] = $claimedSubTask
        Write-Log "Worker $WorkerId claimed task: $taskId (subtask: $claimedSubTask)" "OK"
    } else {
        $script:claimedSubTasks.Remove($taskId) | Out-Null
        Write-Log "Worker $WorkerId claimed task: $taskId" "OK"
    }

    return @{
        TaskId = $taskId
        ClaimedSubTask = $claimedSubTask
    }
}

function Test-BoardComplete {
    $board = Get-BoardJson -RepoPath $MAIN_REPO
    if (-not $board) { return $false }

    $doneIndex = Get-ColumnIndex -Board $board -ColumnName "Done"
    if ($doneIndex -lt 0) { return $false }

    $checkedDone = @{}
    foreach ($lane in $board.lanes) {
        for ($c = 0; $c -lt $lane.columns.Count; $c++) {
            $tasks = Get-ColumnTaskItems -ColumnTasks $lane.columns[$c]
            if ($c -ne $doneIndex) {
                if ($tasks.Count -gt 0) {
                    return $false
                }
                continue
            }

            foreach ($task in $tasks) {
                $taskId = Get-TaskId -Task $task
                if (-not $taskId -or $checkedDone.ContainsKey($taskId)) { continue }
                $checkedDone[$taskId] = $true

                $taskObj = if ($task.PSObject.Properties["subTasks"]) { $task } else { Get-TaskJson -RepoPath $MAIN_REPO -TaskId $taskId }
                if (-not (Test-AllSubTasksComplete -Task $taskObj)) {
                    return $false
                }
            }
        }
    }

    return $true
}

function New-TaskPR {
    param([string]$TaskId)

    $taskBranch = "ralph/$TaskId"

    Push-Location $MAIN_REPO
    try {
        Write-Log "  PR check ${TaskId}..." "DEBUG"

        # Fetch so local tracking refs are current
        # (Publish-WorkerResults pushes from a worktree, so $MAIN_REPO refs are stale)
        git fetch origin $taskBranch $BaseBranch 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Log "  PR skip ${TaskId}: branch not on remote" "WARN"
            return
        }

        # Check for actual changes vs base branch
        $hasChanges = git cherry "origin/$BaseBranch" "origin/$taskBranch" 2>$null | Select-String '^\+'
        if (-not $hasChanges) {
            Write-Log "  PR skip ${TaskId}: no changes vs $BaseBranch" "WARN"
            return
        }

        # Only skip if there's already an OPEN PR (not merged/closed - those may be stale)
        $prState = gh pr view $taskBranch --json state --jq .state 2>$null
        if ($LASTEXITCODE -eq 0 -and $prState -ieq "OPEN") {
            Write-Log "  PR skip ${TaskId}: open PR exists" "DEBUG"
            return
        }

        $prUrl = gh pr create --base $BaseBranch --head $taskBranch `
            --title "ralph: $TaskId" `
            --body "Automated PR for completed task **$TaskId**." 2>$null
        if ($LASTEXITCODE -eq 0 -and $prUrl) {
            Write-Log "Created PR for ${TaskId}: $prUrl" "OK"
        } else {
            Write-Log "PR create failed for ${TaskId} (exit $LASTEXITCODE)" "WARN"
        }
    }
    catch {
        Write-Log "  PR error ${TaskId}: $_" "ERROR"
    }
    finally {
        Pop-Location
    }
}

function New-PRsForDoneTasks {
    $board = Get-BoardJson -RepoPath $MAIN_REPO
    if (-not $board) {
        Write-Log "Cannot read board for Done-task PR sweep" "WARN"
        return
    }

    $doneIndex = Get-ColumnIndex -Board $board -ColumnName "Done"
    if ($doneIndex -lt 0) { return }

    # Collect all task IDs in the Done column
    $doneTaskIds = @{}
    foreach ($lane in $board.lanes) {
        if ($doneIndex -ge $lane.columns.Count) { continue }
        foreach ($task in (Get-ColumnTaskItems -ColumnTasks $lane.columns[$doneIndex])) {
            $taskId = Get-TaskId -Task $task
            if ($taskId) { $doneTaskIds[$taskId] = $true }
        }
    }

    if ($doneTaskIds.Count -eq 0) { return }

    # Match remote ralph/* branches against Done tasks
    $remoteBranches = git -C $MAIN_REPO ls-remote --heads origin "ralph/*" 2>$null
    if (-not $remoteBranches) { return }

    $created = 0
    foreach ($line in @($remoteBranches)) {
        if ($line -match 'refs/heads/(ralph/.+)$') {
            $remoteBranch = $Matches[1]
            if ($remoteBranch -match '^ralph/worker-\d+$') { continue }

            $taskId = $remoteBranch -replace '^ralph/', ''
            if ($doneTaskIds.ContainsKey($taskId)) {
                $created++
                New-TaskPR -TaskId $taskId
            }
        }
    }

    if ($created -gt 0) {
        Write-Log "Processed $created Done task(s) with remote branches" "OK"
    }
}

function Get-WorkerPrompt {
    param(
        [string]$TaskId,
        [string]$ClaimedSubTask
    )

    $subTaskInstructions = ""
    if ($ClaimedSubTask) {
        $subTaskInstructions = @"
YOUR ASSIGNED SUBTASK: $ClaimedSubTask

- Complete this exact sub-task in this cycle
- If it already was completed then that was your work!

"@
    }

    $prompt = @"
@progress.txt

YOUR ASSIGNED TASK ID: $TaskId

$subTaskInstructions

1. Work ONLY on the assigned task above. Do not pick a different task.
Review your task using kanban mcp.

2. Break down what needs to happen.
If the task is too large (more than ~200 lines of changes), break it into
smaller sub-tasks first using kanban mcp edit.

3. Check that the tests pass.

4. Append your progress to the progress.txt file.
Use this to leave a note for the next person working in the codebase.

5. Make a git commit of that feature.

ONLY WORK ON THIS SINGLE TASK. IF THE TASK HAS SUBTASKS, COMPLETE ONLY ONE.

### Rules

- **Never skip tests.** If you can't test it, you can't ship it.
- **Never leave the build broken** between cycles. Every cycle ends with a green build.
- **If a task reveals missing infrastructure**, create a new task with kanban mcp, set it as a blocker relation, and work on it first.
- **Commit atomically.** Each completed task should be one logical unit - all its files work together.
"@

    return $prompt
}

# ============================================================
# Sync & Merge
# ============================================================

function Switch-WorktreeToTaskBranch {
    param([string]$WorktreePath, [string]$TaskId, [string]$BaseBranchName)

    Push-Location $WorktreePath
    try {
        # Save any uncommitted work from the previous task
        $hasStagedOrUntracked = git status --porcelain 2>$null
        if ($hasStagedOrUntracked) {
            git add -A 2>&1 | Out-Null
            git commit -m "WIP: auto-save uncommitted work before task switch" 2>&1 | Out-Null
        }
        # Also commit submodule changes
        git submodule foreach --recursive 'git add -A && git diff --cached --quiet || git commit -m "WIP: auto-save"' 2>&1 | Out-Null
        git add -A 2>&1 | Out-Null
        git diff --cached --quiet 2>$null
        if ($LASTEXITCODE -ne 0) {
            git commit -m "WIP: auto-save submodule refs before task switch" 2>&1 | Out-Null
        }

        $taskBranch = "ralph/$TaskId"
        git fetch origin $BaseBranchName $taskBranch 2>&1 | Out-Null

        # Unmark assume-unchanged on .kanbn files so git can see and discard them
        $kanbnFiles = git ls-files .kanbn 2>$null
        if ($kanbnFiles) {
            $kanbnFiles | ForEach-Object {
                git update-index --no-assume-unchanged $_ 2>$null | Out-Null
            }
        }
        # Discard any dirty .kanbn changes before switching branches
        git checkout -- .kanbn 2>&1 | Out-Null

        # Check if local branch already exists
        $localExists = git rev-parse --verify $taskBranch 2>$null
        if ($localExists) {
            $checkoutOut = git checkout $taskBranch 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Log "  Failed to checkout $taskBranch : $checkoutOut" "ERROR"
                return
            }
        } else {
            # Check if remote branch exists (has prior work)
            $remoteExists = git rev-parse --verify "origin/$taskBranch" 2>$null
            if ($remoteExists) {
                $checkoutOut = git checkout -b $taskBranch "origin/$taskBranch" 2>&1
                if ($LASTEXITCODE -ne 0) {
                    Write-Log "  Failed to checkout remote $taskBranch : $checkoutOut" "ERROR"
                    return
                }
                Write-Log "  Checked out existing remote branch: $taskBranch"
            } else {
                # Fresh branch from latest base
                $checkoutOut = git checkout -b $taskBranch "origin/$BaseBranchName" 2>&1
                if ($LASTEXITCODE -ne 0) {
                    Write-Log "  Failed to create $taskBranch : $checkoutOut" "ERROR"
                    return
                }
            }
        }
    }
    finally {
        Pop-Location
    }
}

function Sync-KanbnToWorktree {
    param([string]$WorktreePath)

    $src = "$MAIN_REPO/.kanbn"
    $dst = "$WorktreePath/.kanbn"

    if (Test-Path $src) {
        if (Test-Path $dst) {
            Remove-Item $dst -Recurse -Force
        }
        Copy-Item $src $dst -Recurse

        # Mark kanbn files as assume-unchanged so they don't pollute task branches
        Push-Location $WorktreePath
        try {
            $kanbnFiles = git ls-files .kanbn 2>$null
            if ($kanbnFiles) {
                $kanbnFiles | ForEach-Object {
                    git update-index --assume-unchanged $_ 2>$null | Out-Null
                }
            }
        }
        finally {
            Pop-Location
        }
    }
}

function Sanitize-TaskFiles {
    param([string]$RepoPath)
    $taskDir = "$RepoPath/.kanbn/tasks"
    if (-not (Test-Path $taskDir)) { return }
    foreach ($file in Get-ChildItem $taskDir -Filter "*.md") {
        $content = [System.IO.File]::ReadAllText($file.FullName, [System.Text.Encoding]::UTF8)
        $original = $content
        $content = $content -replace [char]0x2014, '-'    # em-dash
        $content = $content -replace [char]0x2013, '-'    # en-dash
        $content = $content -replace [char]0x2018, "'"    # left single quote
        $content = $content -replace [char]0x2019, "'"    # right single quote
        $content = $content -replace [char]0x201C, '"'    # left double quote
        $content = $content -replace [char]0x201D, '"'    # right double quote
        $content = $content -replace 'ÔÇö', '-'           # already-corrupted em-dash
        $content = $content -replace 'ÔÇô', '-'           # already-corrupted en-dash
        if ($content -ne $original) {
            [System.IO.File]::WriteAllText($file.FullName, $content, [System.Text.Encoding]::UTF8)
            Write-Log "Sanitized Unicode in task file: $($file.Name)"
        }
    }
}

function Publish-WorkerResults {
    param(
        [string]$WorktreePath,
        [int]$WorkerId,
        [string]$TaskId,
        [string]$TargetBranch
    )

    $taskBranch = "ralph/$TaskId"
    $success = $true

    # 1. Push submodule changes (rebase onto latest remote first)
    foreach ($sub in $SUBMODULES) {
        $subPath = "$WorktreePath/$sub"
        if (-not (Test-Path "$subPath/.git")) { continue }

        Push-Location $subPath
        try {
            $hasCommits = git log --oneline "origin/$TargetBranch..HEAD" 2>$null
            if (-not $hasCommits) { $hasCommits = git log --oneline "origin/main..HEAD" 2>$null }
            if ($hasCommits) {
                $fetchOut = git fetch origin $TargetBranch 2>&1
                Write-Log "  Worker $WorkerId sub $sub fetch: $fetchOut"

                $rebaseOut = git rebase "origin/$TargetBranch" 2>&1
                if ($LASTEXITCODE -ne 0) {
                    Write-Log "  Worker $WorkerId sub $sub rebase failed: $rebaseOut" "WARN"
                    git rebase --abort 2>&1 | Out-Null
                    $success = $false
                    continue
                }

                $pushOut = git push origin "HEAD:$TargetBranch" 2>&1
                if ($LASTEXITCODE -ne 0) {
                    Write-Log "  Worker $WorkerId sub $sub push failed: $pushOut" "ERROR"
                    $success = $false
                }
            }
        }
        finally {
            Pop-Location
        }
    }

    if (-not $success) { return $false }

    # 2. Validate: no conflict markers in the task branch
    if (Test-ConflictMarkers -RepoPath $WorktreePath) {
        Write-Log "Worker $WorkerId BLOCKED: conflict markers detected in task branch, refusing to push" "ERROR"
        return $false
    }

    # 3. Strip .kanbn changes (orchestrator owns kanbn state)
    Push-Location $WorktreePath
    try {
        $fetchOut = git fetch origin $TargetBranch 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log "  Worker $WorkerId fetch failed, skipping kanbn strip: $fetchOut" "WARN"
        }
        $hasKanbnChanges = $false
        $changedFiles = git diff --name-only "origin/$TargetBranch..HEAD" 2>$null
        if ($changedFiles) {
            foreach ($changedFile in @($changedFiles)) {
                if (Test-IsKanbnPath -RelativePath ([string]$changedFile)) {
                    $hasKanbnChanges = $true
                    break
                }
            }
        }
        if ($hasKanbnChanges) {
            Write-Log "  Worker $WorkerId stripping .kanbn changes from task branch" "WARN"
            git checkout "origin/$TargetBranch" -- .kanbn 2>&1 | Out-Null
            git add .kanbn 2>&1 | Out-Null
            git diff --cached --quiet 2>$null
            if ($LASTEXITCODE -ne 0) {
                git commit -m "chore: remove .kanbn edits from worker branch" 2>&1 | Out-Null
            }
        }

        # 4. Push task branch (no merge/rebase into target - just push as-is)
        $pushOut = git push origin "${taskBranch}:${taskBranch}" --force 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Log "Worker $WorkerId failed to push $taskBranch : $pushOut" "ERROR"
            return $false
        }
        Write-Log "Worker $WorkerId pushed $taskBranch" "OK"
    }
    finally {
        Pop-Location
    }

    return $true
}

# ============================================================
# PR Merge via Worker Review
# ============================================================

function Merge-CleanPR {
    param(
        [int]$PRNumber,
        [string]$TargetBranch,
        [string]$WorktreePath
    )

    Push-Location $MAIN_REPO
    try {
        # Check if PR is already merged/closed before doing anything
        $prState = gh pr view $PRNumber --json state --jq .state 2>$null
        if ($prState -ieq "MERGED") {
            Write-Log "  PR #${PRNumber}: already merged, cleaning up branch" "OK"
            $prBranch = (gh pr view $PRNumber --json headRefName --jq .headRefName 2>$null)
            if ($prBranch) {
                git push origin --delete $prBranch 2>&1 | Out-Null
            }
            return $true
        }
        if ($prState -ieq "CLOSED") {
            Write-Log "  PR #${PRNumber}: already closed" "WARN"
            return $false
        }

        # Quick conflict marker check on the diff
        $diff = gh pr diff $PRNumber 2>$null
        if ($LASTEXITCODE -ne 0) {
            Write-Log "  PR #${PRNumber}: failed to fetch diff" "WARN"
            return $false
        }

        $markerLines = $diff | Select-String -Pattern '^\+(<{7} |={7}$|>{7} )' -SimpleMatch:$false
        if ($markerLines) {
            Write-Log "  PR #${PRNumber}: conflict markers found in diff, needs worker review" "WARN"
            return $false
        }

        # Merge directly
        $mergeOut = gh pr merge $PRNumber --rebase 2>&1
        $mergeOutStr = "$mergeOut"
        if ($LASTEXITCODE -eq 0) {
            Write-Log "  PR #${PRNumber}: merged" "OK"
            return $true
        }

        # gh pr merge returns non-zero if branch delete fails even though PR was merged
        if ($mergeOutStr -match "already merged") {
            Write-Log "  PR #${PRNumber}: already merged, cleaning up branch" "OK"
            # Try to delete the remote branch (local may be held by worktree)
            $prBranch = (gh pr view $PRNumber --json headRefName --jq .headRefName 2>$null)
            if ($prBranch) {
                git push origin --delete $prBranch 2>&1 | Out-Null
            }
            return $true
        }

        # Retry after fetch (base branch may have moved)
        git fetch origin $TargetBranch 2>&1 | Out-Null
        $mergeOut = gh pr merge $PRNumber --rebase 2>&1
        $mergeOutStr = "$mergeOut"
        if ($LASTEXITCODE -eq 0) {
            Write-Log "  PR #${PRNumber}: merged (after fetch)" "OK"
            return $true
        }

        if ($mergeOutStr -match "already merged") {
            Write-Log "  PR #${PRNumber}: already merged, cleaning up branch" "OK"
            $prBranch = (gh pr view $PRNumber --json headRefName --jq .headRefName 2>$null)
            if ($prBranch) {
                git push origin --delete $prBranch 2>&1 | Out-Null
            }
            return $true
        }

        # Not mergeable - try local rebase + force-push from a worktree
        if ($WorktreePath -and (Test-Path $WorktreePath)) {
            $prBranch = gh pr view $PRNumber --json headRefName --jq .headRefName 2>$null
            if ($prBranch) {
                Write-Log "  PR #${PRNumber}: rebasing locally..." "WARN"
                Push-Location $WorktreePath
                try {
                    git fetch origin $prBranch $TargetBranch 2>&1 | Out-Null
                    git checkout "origin/$prBranch" --detach 2>&1 | Out-Null
                    if ($LASTEXITCODE -ne 0) {
                        Write-Log "  PR #${PRNumber}: checkout failed" "WARN"
                        return $false
                    }

                    $rebaseOut = git rebase "origin/$TargetBranch" 2>&1
                    if ($LASTEXITCODE -ne 0) {
                        Write-Log "  PR #${PRNumber}: rebase has conflicts, needs worker" "WARN"
                        git rebase --abort 2>&1 | Out-Null
                        return $false
                    }

                    # Verify no conflict markers after rebase
                    $markers = git grep -l -E '^<{7} |^={7}$|^>{7} ' HEAD -- 2>$null
                    if ($LASTEXITCODE -eq 0 -and $markers) {
                        Write-Log "  PR #${PRNumber}: conflict markers after rebase, needs worker" "WARN"
                        return $false
                    }

                    git push origin "HEAD:$prBranch" --force 2>&1 | Out-Null
                    if ($LASTEXITCODE -ne 0) {
                        Write-Log "  PR #${PRNumber}: force-push failed" "WARN"
                        return $false
                    }

                    Write-Log "  PR #${PRNumber}: rebased and pushed" "OK"
                }
                finally {
                    git checkout --detach 2>&1 | Out-Null
                    Pop-Location
                }

                # Retry merge after rebase
                Start-Sleep -Seconds 2  # Let GitHub process the push
                $mergeOut = gh pr merge $PRNumber --rebase 2>&1
                $mergeOutStr = "$mergeOut"
                if ($LASTEXITCODE -eq 0) {
                    Write-Log "  PR #${PRNumber}: merged (after local rebase)" "OK"
                    return $true
                }
                if ($mergeOutStr -match "already merged") {
                    Write-Log "  PR #${PRNumber}: already merged" "OK"
                    git push origin --delete $prBranch 2>&1 | Out-Null
                    return $true
                }
                Write-Log "  PR #${PRNumber}: merge still failed after rebase: $mergeOutStr" "WARN"
                return $false
            }
        }

        Write-Log "  PR #${PRNumber}: merge failed: $mergeOutStr" "WARN"
        return $false
    }
    finally {
        Pop-Location
    }
}

function Cleanup-BranchAfterMerge {
    param(
        [string]$TaskBranch,  # e.g. "ralph/foo"
        [hashtable]$Worktrees = @{}
    )

    # Find if branch is checked out in a worktree
    foreach ($w in $Worktrees.Keys) {
        $currentBranch = git -C $Worktrees[$w] rev-parse --abbrev-ref HEAD 2>$null
        if ($currentBranch -eq $TaskBranch) {
            # Detach HEAD so the branch can be deleted
            # (can't checkout $BaseBranch - it's already checked out in main repo)
            git -C $Worktrees[$w] checkout -- .kanbn 2>&1 | Out-Null
            git -C $Worktrees[$w] checkout --detach 2>&1 | Out-Null
            break
        }
    }

    # Delete the local branch (it's fully merged)
    git -C $MAIN_REPO branch -D $TaskBranch 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Log "  Cleaned up local branch: $TaskBranch" "OK"
    }

    # Delete the remote branch
    git -C $MAIN_REPO push origin --delete $TaskBranch 2>&1 | Out-Null
}

function Get-MergeReviewPrompt {
    param(
        [int]$PRNumber,
        [string]$TaskBranch,
        [string]$TargetBranch
    )

    return @"
You are resolving merge conflicts and merging a pull request.

PR #$PRNumber (branch: $TaskBranch -> $TargetBranch)

IMPORTANT CONSTRAINTS:
- Do NOT run ``gh pr checkout`` (it fails when the branch is checked out in another worktree)
- Do NOT run ``git checkout $TargetBranch`` (it is checked out in the main repo and will fail)
- Do NOT navigate to any other directory — stay in the current working directory
- Use detached HEAD mode for all operations

Steps:
1. Fetch and check out the PR branch in detached HEAD mode:
``````bash
git fetch origin $TaskBranch $TargetBranch
git checkout origin/$TaskBranch --detach
``````

2. Rebase onto the target:
``````bash
git rebase origin/$TargetBranch
``````

3. Resolve ALL merge conflicts. For each conflicting file:
- Read both sides of the conflict carefully
- Keep the intent of both changes (do not discard either side's work)
- Remove all conflict markers (<<<<<<<, =======, >>>>>>>)
- Stage the resolved file and continue the rebase

4. After resolving, verify NO conflict markers remain:
``````bash
git grep -n -E '^<{7} |^={7}$|^>{7} ' -- '*.cpp' '*.h' '*.md' '*.txt' '*.cmake'
``````
If any results appear, you MUST fix them before proceeding.

5. Build and run tests to verify the resolution is correct:
``````bash
cmake --build cmake-build-debug --target tests && cmake-build-debug/git/tests/tests.exe --unit
``````

6. Force-push the rebased branch:
``````bash
git push origin HEAD:$TaskBranch --force
``````

7. Merge the PR:
``````bash
gh pr merge $PRNumber --rebase
``````

If you cannot resolve the conflicts cleanly, abort:
``````bash
git rebase --abort
``````
Then leave a comment explaining the issue:
``````bash
gh pr comment $PRNumber --body "Unable to auto-resolve conflicts: [explain what conflicts and why]"
``````

CRITICAL: Never push files containing conflict markers. Always verify with git grep before pushing.
"@
}

function Start-MergeReviewWorker {
    param(
        [int]$WorkerId,
        [int]$PRNumber,
        [string]$TaskBranch,
        [string]$TargetBranch,
        [string]$LogFile,
        [string]$WorktreePath
    )

    $prompt = Get-MergeReviewPrompt -PRNumber $PRNumber -TaskBranch $TaskBranch -TargetBranch $TargetBranch

    $targetBranchCapture = $TargetBranch

    $scriptBlock = {
        param(
            [int]$WorkerId,
            [string]$WorkDir,
            [int]$PRNumber,
            [string]$Prompt,
            [string]$LogFile,
            [string]$BaseBranch
        )

        Set-Location $WorkDir

        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Add-Content $LogFile "[$timestamp] Worker $WorkerId - Reviewing PR #$PRNumber"

        try {
            $result = $Prompt | claude --permission-mode bypassPermissions -p 2>&1
            $exitCode = $LASTEXITCODE
            $resultText = $result -join "`n"

            $iterLog = "$LogFile.merge-review-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
            Set-Content $iterLog $resultText
            Add-Content $LogFile "[$timestamp] Worker $WorkerId - Merge review exit code: $exitCode (saved to $iterLog)"

            $status = if ($exitCode -eq 0) { "MERGE_REVIEW_DONE" } else { "MERGE_REVIEW_ERROR" }
            return @{ Status = $status; WorkerId = $WorkerId; PRNumber = $PRNumber }
        }
        finally {
            # Detach HEAD to release any branch lock (don't checkout $BaseBranch — it's in MAIN_REPO)
            git checkout --detach 2>&1 | Out-Null
        }
    }

    $job = Start-Job -ScriptBlock $scriptBlock -ArgumentList @(
        $WorkerId, $WorktreePath, $PRNumber, $prompt, $LogFile, $targetBranchCapture
    )

    return $job
}

function Get-PendingRalphPRs {
    Push-Location $MAIN_REPO
    try {
        $prs = gh pr list --json number,headRefName,mergeable,mergeStateStatus 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $prs) { return @() }

        $parsed = $prs | ConvertFrom-Json -ErrorAction SilentlyContinue
        if (-not $parsed) { return @() }
        return @($parsed | Where-Object { $_.headRefName -like "ralph/*" })
    }
    finally {
        Pop-Location
    }
}

function Complete-DrainJob {
    param($DrainJob, [int]$WorkerId, [string]$MergeWorktreePath, [hashtable]$Worktrees = @{})

    $djResult = Receive-Job $DrainJob.Job -ErrorAction SilentlyContinue
    Remove-Job $DrainJob.Job -Force
    $djStatus = if ($djResult.Status) { $djResult.Status } else { "UNKNOWN" }
    $prNum = $DrainJob.PRNumber
    Write-Log "  Worker $WorkerId merge review PR #${prNum}: $djStatus"

    if ($djStatus -eq "MERGE_REVIEW_DONE") {
        $prBranch = gh pr view $prNum --json headRefName --jq .headRefName 2>$null
        $prState = gh pr view $prNum --json state --jq .state 2>$null

        if ($prState -ieq "MERGED") {
            Write-Log "  PR #${prNum}: already merged by worker, cleaning up" "OK"
            if ($prBranch) { Cleanup-BranchAfterMerge -TaskBranch $prBranch -Worktrees $Worktrees }
        } elseif ($prState -ieq "OPEN") {
            Write-Log "  PR #${prNum}: still open after worker review, retrying merge..."
            if (Merge-CleanPR -PRNumber $prNum -TargetBranch $BaseBranch -WorktreePath $MergeWorktreePath) {
                if ($prBranch) { Cleanup-BranchAfterMerge -TaskBranch $prBranch -Worktrees $Worktrees }
            } else {
                Write-Log "  PR #${prNum}: merge still failed after worker review" "WARN"
            }
        } else {
            Write-Log "  PR #${prNum}: unexpected state '$prState' after worker review" "WARN"
        }
    }
}

function Invoke-DrainPendingPRs {
    param(
        [string]$MergeWorktreePath,
        [hashtable]$Worktrees = @{}
    )

    $pendingPRs = @(Get-PendingRalphPRs)
    if ($pendingPRs.Count -eq 0) {
        Write-Log "No pending ralph PRs found." "OK"
        return
    }

    Write-Log "Found $($pendingPRs.Count) pending PR(s), draining..."
    # Cap to 1 concurrent merge-review worker
    $availableWorkers = @(1)
    $drainJobs = @{}
    $drainedPRs = @{}

    foreach ($pr in $pendingPRs) {
        $prNum = $pr.number
        $prBranch = $pr.headRefName

        if ($drainedPRs.ContainsKey($prNum)) { continue }

        # Try direct merge + local rebase first
        Write-Log "  PR #$prNum ($prBranch): attempting merge..."
        if (Merge-CleanPR -PRNumber $prNum -TargetBranch $BaseBranch -WorktreePath $MergeWorktreePath) {
            Cleanup-BranchAfterMerge -TaskBranch $prBranch -Worktrees $Worktrees
            $drainedPRs[$prNum] = $true
            continue
        }

        # Fall back to worker for conflict resolution
        $pickWorker = $null
        foreach ($w in $availableWorkers) {
            if (-not $drainJobs.ContainsKey($w)) {
                $pickWorker = $w
                break
            }
        }

        # If all workers busy, wait for one to finish
        if (-not $pickWorker) {
            while (-not $pickWorker) {
                Start-Sleep -Seconds 5
                foreach ($w in @($drainJobs.Keys)) {
                    $dj = $drainJobs[$w]
                    if ($dj.Job.State -eq 'Completed' -or $dj.Job.State -eq 'Failed') {
                        Complete-DrainJob -DrainJob $dj -WorkerId $w -MergeWorktreePath $MergeWorktreePath -Worktrees $Worktrees
                        $drainJobs.Remove($w)
                        $pickWorker = $w
                        break
                    }
                }
            }
        }

        $logFile = "$LOG_DIR/worker-$pickWorker.log"
        Write-Log "  Worker $pickWorker dispatched on merge review: PR #$prNum ($prBranch)"
        $job = Start-MergeReviewWorker `
            -WorkerId $pickWorker `
            -PRNumber $prNum `
            -TaskBranch $prBranch `
            -TargetBranch $BaseBranch `
            -LogFile $logFile `
            -WorktreePath $MergeWorktreePath

        $drainJobs[$pickWorker] = @{ Job = $job; PRNumber = $prNum }
        $drainedPRs[$prNum] = $true
    }

    # Wait for remaining jobs
    while ($drainJobs.Count -gt 0) {
        Start-Sleep -Seconds 10
        foreach ($w in @($drainJobs.Keys)) {
            $dj = $drainJobs[$w]
            if ($dj.Job.State -eq 'Completed' -or $dj.Job.State -eq 'Failed') {
                Complete-DrainJob -DrainJob $dj -WorkerId $w -MergeWorktreePath $MergeWorktreePath -Worktrees $Worktrees
                $drainJobs.Remove($w)
            }
        }
    }

    Write-Log "Drain complete" "OK"
}

# ============================================================
# Worker Execution
# ============================================================

function Start-Worker {
    param(
        [int]$WorkerId,
        [string]$WorktreePath,
        [string]$TaskId,
        [string]$ClaimedSubTask,
        [string]$LogFile,
        [string]$BaseBranchName
    )

    $prompt = Get-WorkerPrompt -TaskId $TaskId -ClaimedSubTask $ClaimedSubTask

    $scriptBlock = {
        param(
            [int]$WorkerId,
            [string]$WorktreePath,
            [string]$TaskId,
            [string]$Prompt,
            [string]$LogFile,
            [string]$BaseBranchName
        )

        Set-Location $WorktreePath

        $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
        Add-Content $LogFile "[$timestamp] Worker $WorkerId - Running task $TaskId"

        $result = $Prompt | claude --permission-mode bypassPermissions -p 2>&1
        $exitCode = $LASTEXITCODE
        $resultText = $result -join "`n"

        if ($exitCode -ne 0) {
            $iterLog = "$LogFile.iter-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
            Set-Content $iterLog $resultText
            Add-Content $LogFile "[$timestamp] Worker $WorkerId - ERROR: exit code $exitCode (saved to $iterLog)"
            return @{ Status = "ERROR"; WorkerId = $WorkerId; TaskId = $TaskId; Error = "claude exited with code $exitCode" }
        }

        # Save full Claude output to per-iteration log file
        $iterLog = "$LogFile.iter-$(Get-Date -Format 'yyyyMMdd-HHmmss').txt"
        Set-Content $iterLog $resultText
        Add-Content $LogFile "[$timestamp] Worker $WorkerId - Result length: $($resultText.Length) (saved to $iterLog)"

        # Auto-commit any uncommitted submodule work before checking
        git -C $WorktreePath submodule foreach --recursive 'git add -A && git diff --cached --quiet || git commit -m "auto: uncommitted work"' 2>$null | Out-Null
        $rescueDirty = git -C $WorktreePath status --porcelain 2>$null
        if ($rescueDirty) {
            git -C $WorktreePath add -A 2>$null | Out-Null
            git -C $WorktreePath commit -m "auto: save uncommitted submodule and file changes" 2>$null | Out-Null
        }

        # Completion is based on non-.kanbn repo changes only.
        $changedFiles = git -C $WorktreePath diff --name-only "$BaseBranchName..HEAD" 2>$null
        $hasNonKanbnChanges = $false
        if ($changedFiles) {
            foreach ($changedFile in @($changedFiles)) {
                $normalized = ([string]$changedFile) -replace '\\', '/'
                if (-not ($normalized -eq ".kanbn" -or $normalized.StartsWith(".kanbn/"))) {
                    $hasNonKanbnChanges = $true
                    break
                }
            }
        }
        $status = if ($hasNonKanbnChanges) { "TASK_COMPLETE" } else { "NO_COMMITS" }

        return @{ Status = $status; WorkerId = $WorkerId; TaskId = $TaskId }
    }

    $job = Start-Job -ScriptBlock $scriptBlock -ArgumentList @(
        $WorkerId, $WorktreePath, $TaskId, $prompt, $LogFile, $BaseBranchName
    )

    return $job
}

# ============================================================
# Main
# ============================================================

# Handle -Cleanup flag
if ($Cleanup) {
    New-Item -Path $WORKTREE_ROOT -ItemType Directory -Force | Out-Null
    New-Item -Path $LOG_DIR -ItemType Directory -Force | Out-Null
    Write-Log "Merging pending PRs before cleanup..."
    Invoke-DrainPendingPRs
    Remove-AllWorktrees
    return
}

# Handle -MergeOnly flag: skip all task work, just drain pending PRs
if ($MergeOnly) {
    $mergeWorkers = if ($Workers -ge 1) { $Workers } else { 1 }

    foreach ($cmd in @("claude", "git", "gh")) {
        if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
            Write-Host "Required command not found: $cmd" -ForegroundColor Red
            return
        }
    }

    New-Item -Path $WORKTREE_ROOT -ItemType Directory -Force | Out-Null
    New-Item -Path $LOG_DIR -ItemType Directory -Force | Out-Null

    Write-Log "=== Ralph Parallel (merge-only) ==="
    Write-Log "Merge workers: $mergeWorkers | Base branch: $BaseBranch | Main repo: $MAIN_REPO"
    Write-Host ""

    Ensure-UnionMergeForProgressTxt

    $mergeWorktreePath = New-MergeWorktree
    if (-not $mergeWorktreePath) {
        Write-Log "Failed to create merge worktree, aborting" "ERROR"
        return
    }
    Initialize-Submodules -WorktreePath $mergeWorktreePath
    Patch-ClaudeMD -WorktreePath $mergeWorktreePath

    try {
        New-PRsForDoneTasks
        Invoke-DrainPendingPRs -MergeWorktreePath $mergeWorktreePath
        Prune-MergedRalphBranches
    }
    finally {
        Remove-MergeWorktree
    }
    return
}

# Validate
if ($Workers -lt 1) {
    Write-Host "Usage: Ralph-Loop [-Workers N] [-IterationsPerWorker N] [-BaseBranch branch]"
    return
}

foreach ($cmd in @("claude", "git", "gh")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "Required command not found: $cmd" -ForegroundColor Red
        return
    }
}

Write-Log "=== Ralph Parallel ==="
Write-Log "Workers: $Workers | Iterations/worker: $IterationsPerWorker | Total budget: $($Workers * $IterationsPerWorker)"
Write-Log "Base branch: $BaseBranch | Main repo: $MAIN_REPO"
Write-Host ""

# Create directories
New-Item -Path $WORKTREE_ROOT -ItemType Directory -Force | Out-Null
New-Item -Path $LOG_DIR -ItemType Directory -Force | Out-Null

# Main orchestration with cleanup on exit
$activeJobs = @{}
$worktrees = @{}
$totalCompleted = 0
$maxIterations = $Workers * $IterationsPerWorker
$totalIterations = 0
$boardComplete = $false

try {
    # Phase 1: Setup
    Ensure-UnionMergeForProgressTxt
    Write-Log "Phase 1: Setting up $Workers worktrees..."
    for ($w = 1; $w -le $Workers; $w++) {
        Write-Log "--- Worker $w setup ---"
        $path = New-RalphWorktree -WorkerId $w
        if (-not $path) {
            Write-Log "Skipping worker $w due to worktree creation failure" "ERROR"
            continue
        }
        Initialize-Submodules -WorktreePath $path
        Patch-ClaudeMD -WorktreePath $path

        if (-not $SkipBuild) {
            $configured = Configure-WorktreeBuild -WorktreePath $path
            if (-not $configured) {
                Write-Log "Skipping worker $w due to build failure" "ERROR"
                continue
            }
        }

        $worktrees[$w] = $path
    }

    if ($worktrees.Count -eq 0) {
        Write-Log "No worktrees were created successfully. Exiting." "ERROR"
        return
    }

    # Setup merge worktree for PR review/conflict resolution
    Write-Log "--- Merge worker setup ---"
    $mergeWorktreePath = New-MergeWorktree
    if ($mergeWorktreePath) {
        Initialize-Submodules -WorktreePath $mergeWorktreePath
        Patch-ClaudeMD -WorktreePath $mergeWorktreePath
    } else {
        Write-Log "Merge worktree creation failed, merge reviews will be skipped" "WARN"
    }

    # Sanitize Unicode in task files (em-dashes, smart quotes, etc.)
    Write-Log ""
    Write-Log "Sanitizing task files..."
    Sanitize-TaskFiles -RepoPath $MAIN_REPO

    # Repair any invalid Done cards before dispatch
    Write-Log ""
    Write-Log "Repairing Done cards with incomplete subtasks..."
    Repair-DoneCardsWithIncompleteSubTasks

    # Phase 2: Initial task claim and dispatch
    Write-Log ""
    Write-Log "Phase 2: Dispatching workers..."
    foreach ($w in $worktrees.Keys) {
        $claim = Claim-NextTask -WorkerId $w -Worktrees $worktrees
        if (-not $claim) {
            Write-Log "No tasks available for worker $w" "WARN"
            continue
        }

        $taskId = $claim.TaskId
        $claimedSubTask = $claim.ClaimedSubTask

        Switch-WorktreeToTaskBranch -WorktreePath $worktrees[$w] -TaskId $taskId -BaseBranchName $BaseBranch
        Sync-KanbnToWorktree -WorktreePath $worktrees[$w]
        $logFile = "$LOG_DIR/worker-$w.log"

        $job = Start-Worker `
            -WorkerId $w `
            -WorktreePath $worktrees[$w] `
            -TaskId $taskId `
            -ClaimedSubTask $claimedSubTask `
            -LogFile $logFile `
            -BaseBranchName $BaseBranch

        $activeJobs[$w] = @{ Job = $job; TaskId = $taskId; ClaimedSubTask = $claimedSubTask }
        if ($claimedSubTask) {
            Write-Log "Worker $w dispatched on task: $taskId (subtask: $claimedSubTask)"
        } else {
            Write-Log "Worker $w dispatched on task: $taskId"
        }
    }

    if ($activeJobs.Count -eq 0) {
        Write-Log "No tasks to work on. Board may be empty." "WARN"
        return
    }

    # Phase 3: Monitor loop
    Write-Log ""
    Write-Log "Phase 3: Monitoring workers..."
    $noCommitCounts = @{} # Track consecutive NO_COMMITS per task::subtask
    $shutdownRequested = $false
    [Console]::TreatControlCAsInput = $true

    while ($activeJobs.Count -gt 0 -and -not $boardComplete -and -not $shutdownRequested) {
        # Poll for Ctrl+C during the 10-second wait
        for ($tick = 0; $tick -lt 20; $tick++) {
            Start-Sleep -Milliseconds 500
            while ([Console]::KeyAvailable) {
                $key = [Console]::ReadKey($true)
                if ($key.Key -eq 'C' -and ($key.Modifiers -band [ConsoleModifiers]::Control)) {
                    $shutdownRequested = $true
                    break
                }
            }
            if ($shutdownRequested) { break }
        }
        if ($shutdownRequested) { break }

        # Guard: ensure MAIN_REPO stays on the correct branch (merge workers can corrupt this)
        $currentMain = git -C $MAIN_REPO rev-parse --abbrev-ref HEAD 2>$null
        if ($currentMain -and $currentMain -ne $BaseBranch) {
            Write-Log "MAIN_REPO on '$currentMain' instead of '$BaseBranch', restoring!" "ERROR"
            git -C $MAIN_REPO checkout $BaseBranch 2>&1 | Out-Null
        }

        foreach ($workerId in @($activeJobs.Keys)) {
            $jobInfo = $activeJobs[$workerId]
            $job = $jobInfo.Job

            if ($job.State -eq 'Completed') {
                $result = Receive-Job $job -ErrorAction SilentlyContinue
                Remove-Job $job -Force

                $status = if ($result.Status) { $result.Status } else { "UNKNOWN" }
                Write-Log "Worker $workerId finished: $status (task: $($jobInfo.TaskId))"

                # Task completion - publish + kanbn handling
                $claimedSubTask = if ($jobInfo.ContainsKey("ClaimedSubTask")) { $jobInfo.ClaimedSubTask } else { $null }
                $workerTaskSnapshot = $null
                $workerColumnSnapshot = $null
                if ($status -eq "TASK_COMPLETE") {
                    # Read task state from main repo (MCP writes there directly via KANBAN_ROOT).
                    $workerTaskSnapshot = Get-TaskJson -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId
                    $workerColumnSnapshot = Get-TaskColumn -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId
                }

                # Publish if there are any non-.kanbn changes (regardless of status).
                $taskBranch = "ralph/$($jobInfo.TaskId)"
                $hasPublishableChanges = Test-HasNonKanbnChangesInRange -RepoPath $worktrees[$workerId] -RangeSpec "$BaseBranch..$taskBranch"
                if ($hasPublishableChanges) {
                    $published = Publish-WorkerResults `
                        -WorktreePath $worktrees[$workerId] `
                        -WorkerId $workerId `
                        -TaskId $jobInfo.TaskId `
                        -TargetBranch $BaseBranch

                    if ($published) {
                        Write-Log "Worker ${workerId}: pushed branch for $($jobInfo.TaskId)" "OK"
                    } else {
                        Write-Log "Worker ${workerId}: publish failed for $($jobInfo.TaskId)" "ERROR"
                    }
                }

                $totalIterations++
                $totalCompleted++
                Write-Log "Worker ${workerId}: iteration $totalIterations / $maxIterations (budget)"

                if ($status -eq "TASK_COMPLETE") {
                    $workerTask = $workerTaskSnapshot
                    $workerColumn = $workerColumnSnapshot
                    $workerMovedTaskToDone = ($workerColumn -ieq "Done")
                    $workerCheckedClaimedSubTask = Test-SubTaskComplete -Task $workerTask -SubTaskText $claimedSubTask

                    if ($claimedSubTask -and ($workerCheckedClaimedSubTask -or $workerMovedTaskToDone)) {
                        if (Complete-SubTaskInRepo -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId -SubTaskText $claimedSubTask) {
                            if ($workerCheckedClaimedSubTask) {
                                Write-Log "Synced completed subtask from worker: $claimedSubTask" "OK"
                            } else {
                                Write-Log "Worker moved $($jobInfo.TaskId) to Done; assuming claimed subtask complete: $claimedSubTask" "WARN"
                            }
                        } else {
                            Write-Log "Failed to sync claimed subtask to main board: $claimedSubTask" "WARN"
                        }
                    } elseif ($claimedSubTask) {
                        # Worker completed code but didn't check off kanbn subtask - force-mark it
                        # to prevent infinite re-assignment of already-done work
                        if (Complete-SubTaskInRepo -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId -SubTaskText $claimedSubTask) {
                            Write-Log "Force-marked subtask complete (worker had TASK_COMPLETE but didn't check it off): $claimedSubTask" "WARN"
                        } else {
                            Write-Log "Failed to force-mark subtask; may loop: $claimedSubTask" "ERROR"
                        }
                    }

                    $mainTask = Get-TaskJson -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId
                    $allSubTasksComplete = Test-AllSubTasksComplete -Task $mainTask

                    if ($allSubTasksComplete) {
                        Move-KanbanTask -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId -Column "Done" | Out-Null
                        $script:completedTasks[$jobInfo.TaskId] = $true
                        New-TaskPR -TaskId $jobInfo.TaskId
                        Release-TaskClaim -TaskId $jobInfo.TaskId

                        if (Test-BoardComplete) {
                            Write-Log "All tasks are in Done column with complete subtasks" "OK"
                            $boardComplete = $true
                        }
                    } else {
                        # Stay on same task — advance to next subtask
                        $nextSub = Get-FirstIncompleteSubTask -Task $mainTask
                        if ($nextSub) {
                            $script:claimedSubTasks[$jobInfo.TaskId] = $nextSub
                            Write-Log "Worker $workerId advancing to next subtask: $nextSub"
                            Sync-KanbnToWorktree -WorktreePath $worktrees[$workerId]
                            $logFile = "$LOG_DIR/worker-$workerId.log"
                            $newJob = Start-Worker -WorkerId $workerId -WorktreePath $worktrees[$workerId] `
                                -TaskId $jobInfo.TaskId -ClaimedSubTask $nextSub -LogFile $logFile -BaseBranchName $BaseBranch
                            $activeJobs[$workerId] = @{ Job = $newJob; TaskId = $jobInfo.TaskId; ClaimedSubTask = $nextSub }
                            continue
                        } else {
                            Move-KanbanTask -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId -Column "Done" | Out-Null
                            $script:completedTasks[$jobInfo.TaskId] = $true
                            New-TaskPR -TaskId $jobInfo.TaskId
                            Release-TaskClaim -TaskId $jobInfo.TaskId
                        }
                    }
                }
                elseif ($status -eq "ERROR") {
                    Move-KanbanTask -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId -Column "Todo" | Out-Null
                    Release-TaskClaim -TaskId $jobInfo.TaskId
                    Write-Log "Task $($jobInfo.TaskId) errored" "WARN"
                } elseif ($status -ne "NO_COMMITS") {
                    Release-TaskClaim -TaskId $jobInfo.TaskId
                }

                # Decide next work: same task (NO_COMMITS) > new kanbn task
                if (-not $boardComplete -and $totalIterations -lt $maxIterations) {
                    $dispatched = $false

                    if ($status -eq "NO_COMMITS") {
                        $ncKey = "$($jobInfo.TaskId)::$($jobInfo.ClaimedSubTask)"
                        if (-not $noCommitCounts.ContainsKey($ncKey)) { $noCommitCounts[$ncKey] = 0 }
                        $noCommitCounts[$ncKey]++

                        # Check subtask completion BEFORE any worktree reset (reset wipes .kanbn state)
                        $claimedSubTask = $jobInfo.ClaimedSubTask
                        $advanced = $false
                        if ($claimedSubTask) {
                            $workerTask = Get-TaskJson -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId
                            $workerChecked = Test-SubTaskComplete -Task $workerTask -SubTaskText $claimedSubTask
                            if ($workerChecked) {
                                # Sync to main repo (mirrors TASK_COMPLETE path)
                                if (Complete-SubTaskInRepo -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId -SubTaskText $claimedSubTask) {
                                    Write-Log "Synced completed subtask from worker (NO_COMMITS): $claimedSubTask" "OK"
                                } else {
                                    Write-Log "Failed to sync subtask to main repo: $claimedSubTask" "WARN"
                                }
                                $noCommitCounts.Remove($ncKey)

                                # Advance to next incomplete subtask on same task
                                $mainTask = Get-TaskJson -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId
                                $nextSub = Get-FirstIncompleteSubTask -Task $mainTask
                                if ($nextSub) {
                                    Write-Log "Worker $workerId advancing to next subtask: $nextSub"
                                    $nextClaim = @{ TaskId = $jobInfo.TaskId; ClaimedSubTask = $nextSub }
                                    $script:claimedSubTasks[$jobInfo.TaskId] = $nextSub

                                    Sync-KanbnToWorktree -WorktreePath $worktrees[$workerId]
                                    $logFile = "$LOG_DIR/worker-$workerId.log"
                                    $newJob = Start-Worker `
                                        -WorkerId $workerId `
                                        -WorktreePath $worktrees[$workerId] `
                                        -TaskId $nextClaim.TaskId `
                                        -ClaimedSubTask $nextClaim.ClaimedSubTask `
                                        -LogFile $logFile `
                                        -BaseBranchName $BaseBranch

                                    $activeJobs[$workerId] = @{ Job = $newJob; TaskId = $nextClaim.TaskId; ClaimedSubTask = $nextClaim.ClaimedSubTask }
                                    $dispatched = $true
                                    $advanced = $true
                                } else {
                                    # All subtasks done - move to Done, create PR, release claim
                                    Write-Log "All subtasks complete for $($jobInfo.TaskId), moving to Done" "OK"
                                    Move-KanbanTask -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId -Column "Done" | Out-Null
                                    $script:completedTasks[$jobInfo.TaskId] = $true
                                    New-TaskPR -TaskId $jobInfo.TaskId
                                    Release-TaskClaim -TaskId $jobInfo.TaskId
                                    $advanced = $true

                                    if (Test-BoardComplete) {
                                        Write-Log "All tasks are in Done column with complete subtasks" "OK"
                                        $boardComplete = $true
                                    }
                                }
                            }
                        }

                        if (-not $advanced) {
                            # Bail out after 5 consecutive NO_COMMITS on same subtask
                            if ($noCommitCounts[$ncKey] -ge 5) {
                                Write-Log "Worker ${workerId}: $($noCommitCounts[$ncKey]) NO_COMMITS on $ncKey, giving up" "WARN"
                                Move-KanbanTask -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId -Column "Todo" | Out-Null
                                Release-TaskClaim -TaskId $jobInfo.TaskId
                                $noCommitCounts.Remove($ncKey)
                                # fall through to Priority 1/2
                            } else {
                                # Reset worktree after 3 consecutive failures
                                if ($noCommitCounts[$ncKey] -ge 3) {
                                    Write-Log "Worker ${workerId}: $($noCommitCounts[$ncKey]) consecutive NO_COMMITS on $ncKey, resetting worktree for clean slate"
                                    git -C $worktrees[$workerId] submodule foreach --recursive 'git checkout -- . && git clean -fd' 2>$null | Out-Null
                                    git -C $worktrees[$workerId] checkout -- . 2>$null | Out-Null
                                    git -C $worktrees[$workerId] clean -fd 2>$null | Out-Null
                                    git -C $worktrees[$workerId] reset --hard $BaseBranch 2>$null | Out-Null
                                    Switch-WorktreeToTaskBranch -WorktreePath $worktrees[$workerId] -TaskId $jobInfo.TaskId -BaseBranchName $BaseBranch
                                }

                                # Keep retrying same task+subtask
                                $nextClaim = @{
                                    TaskId = $jobInfo.TaskId
                                    ClaimedSubTask = $jobInfo.ClaimedSubTask
                                }
                                Write-Log "Worker $workerId continuing on task: $($nextClaim.TaskId)"

                                Sync-KanbnToWorktree -WorktreePath $worktrees[$workerId]
                                $logFile = "$LOG_DIR/worker-$workerId.log"
                                $newJob = Start-Worker `
                                    -WorkerId $workerId `
                                    -WorktreePath $worktrees[$workerId] `
                                    -TaskId $nextClaim.TaskId `
                                    -ClaimedSubTask $nextClaim.ClaimedSubTask `
                                    -LogFile $logFile `
                                    -BaseBranchName $BaseBranch

                                $activeJobs[$workerId] = @{ Job = $newJob; TaskId = $nextClaim.TaskId; ClaimedSubTask = $nextClaim.ClaimedSubTask }
                                $dispatched = $true
                            }
                        }
                    }

                    # Priority 1: Try instant merge of pending PRs (no worker dispatch — conflict resolution deferred to Phase 3b)
                    if (-not $dispatched) {
                        # Reset NO_COMMITS counter on success
                        $ncKey = "$($jobInfo.TaskId)::$($jobInfo.ClaimedSubTask)"
                        if ($noCommitCounts.ContainsKey($ncKey)) { $noCommitCounts.Remove($ncKey) }

                        if ($mergeWorktreePath) {
                            $pendingPRs = Get-PendingRalphPRs
                            foreach ($pr in $pendingPRs) {
                                Write-Log "Worker ${workerId}: attempting merge of PR #$($pr.number) ($($pr.headRefName))..."
                                if (Merge-CleanPR -PRNumber $pr.number -TargetBranch $BaseBranch -WorktreePath $mergeWorktreePath) {
                                    Cleanup-BranchAfterMerge -TaskBranch $pr.headRefName -Worktrees $worktrees
                                }
                                # If merge fails, Phase 3b will handle conflict resolution
                            }
                        }
                    }

                    # Priority 2: Claim next kanbn task
                    if (-not $dispatched) {
                        $nextClaim = Claim-NextTask -WorkerId $workerId -Worktrees $worktrees
                        if ($nextClaim) {
                            $nextTask = $nextClaim.TaskId
                            $nextSubTask = $nextClaim.ClaimedSubTask

                            Switch-WorktreeToTaskBranch -WorktreePath $worktrees[$workerId] -TaskId $nextTask -BaseBranchName $BaseBranch
                            Sync-KanbnToWorktree -WorktreePath $worktrees[$workerId]
                            $logFile = "$LOG_DIR/worker-$workerId.log"

                            $newJob = Start-Worker `
                                -WorkerId $workerId `
                                -WorktreePath $worktrees[$workerId] `
                                -TaskId $nextTask `
                                -ClaimedSubTask $nextSubTask `
                                -LogFile $logFile `
                                -BaseBranchName $BaseBranch

                            $activeJobs[$workerId] = @{ Job = $newJob; TaskId = $nextTask; ClaimedSubTask = $nextSubTask }
                            if ($nextSubTask) {
                                Write-Log "Worker $workerId restarted on task: $nextTask (subtask: $nextSubTask)"
                            } else {
                                Write-Log "Worker $workerId restarted on task: $nextTask"
                            }
                            $dispatched = $true
                        }
                    }

                    if (-not $dispatched) {
                        $activeJobs.Remove($workerId)
                        Write-Log "Worker ${workerId}: no more tasks or PRs, shutting down"
                    }
                }
                else {
                    $activeJobs.Remove($workerId)
                }
            }
            elseif ($job.State -eq 'Failed') {
                $reason = if ($job.ChildJobs -and $job.ChildJobs[0].JobStateInfo.Reason) {
                    $job.ChildJobs[0].JobStateInfo.Reason.Message
                } else { "Unknown error" }

                Write-Log "Worker $workerId FAILED: $reason" "ERROR"
                Remove-Job $job -Force

                # Only move real kanbn tasks back to Todo (not merge-review pseudo-tasks)
                if ($jobInfo.TaskId -and $jobInfo.TaskId -ne "merge-review") {
                    Move-KanbanTask -RepoPath $MAIN_REPO -TaskId $jobInfo.TaskId -Column "Todo" | Out-Null
                    Release-TaskClaim -TaskId $jobInfo.TaskId
                }

                $activeJobs.Remove($workerId)
            }
        }
    }

    # Graceful shutdown: wait for running workers to finish
    if ($shutdownRequested) {
        Write-Log ""
        Write-Log "Ctrl+C received -- waiting for running workers to finish..." "WARN"
        while ($activeJobs.Count -gt 0) {
            Start-Sleep -Seconds 5
            foreach ($workerId in @($activeJobs.Keys)) {
                $job = $activeJobs[$workerId].Job
                if ($job.State -ne 'Running') {
                    $result = Receive-Job $job -ErrorAction SilentlyContinue
                    Remove-Job $job -Force -ErrorAction SilentlyContinue
                    $activeJobs.Remove($workerId)
                    Write-Log "Worker $workerId finished (shutdown drain)" "OK"
                }
            }
        }
    }

    # Wait for remaining workers to finish gracefully if board is complete
    if ($boardComplete -and $activeJobs.Count -gt 0) {
        Write-Log "Board complete -- waiting for $($activeJobs.Count) active worker(s) to finish..."
        while ($activeJobs.Count -gt 0) {
            Start-Sleep -Seconds 5
            foreach ($workerId in @($activeJobs.Keys)) {
                $jobInfo = $activeJobs[$workerId]
                $job = $jobInfo.Job
                if ($job.State -eq 'Completed' -or $job.State -eq 'Failed') {
                    if ($job.State -eq 'Completed') {
                        $result = Receive-Job $job -ErrorAction SilentlyContinue
                        Remove-Job $job -Force
                        $status = if ($result.Status) { $result.Status } else { "UNKNOWN" }
                        Write-Log "Worker $workerId finished (drain): $status (task: $($jobInfo.TaskId))"

                        # Publish any work from this worker
                        $taskBranch = "ralph/$($jobInfo.TaskId)"
                        $hasPublishableChanges = Test-HasNonKanbnChangesInRange -RepoPath $worktrees[$workerId] -RangeSpec "$BaseBranch..$taskBranch"
                        if ($hasPublishableChanges) {
                            $published = Publish-WorkerResults `
                                -WorktreePath $worktrees[$workerId] `
                                -WorkerId $workerId `
                                -TaskId $jobInfo.TaskId `
                                -TargetBranch $BaseBranch
                            if ($published) {
                                Write-Log "Worker ${workerId}: pushed branch for $($jobInfo.TaskId)" "OK"
                            }
                        }
                    } else {
                        Write-Log "Worker $workerId failed (drain): $($jobInfo.TaskId)" "WARN"
                        Remove-Job $job -Force
                    }
                    $activeJobs.Remove($workerId)
                }
            }
        }
        Write-Log "All workers finished"
    }

    # Phase 3b: Drain any pending ralph PRs before cleanup
    if (-not $shutdownRequested) {
        Write-Log ""
        Write-Log "Phase 3b: Draining pending PRs..."
        Invoke-DrainPendingPRs -MergeWorktreePath $mergeWorktreePath -Worktrees $worktrees
    }
}
finally {
    [Console]::TreatControlCAsInput = $false

    # Phase 4: Cleanup
    Write-Host ""
    Write-Log "Phase 4: Cleanup..."

    # Stop any remaining jobs
    foreach ($workerId in @($activeJobs.Keys)) {
        $job = $activeJobs[$workerId].Job
        if ($job.State -eq 'Running') {
            Stop-Job $job -ErrorAction SilentlyContinue
        }
        Remove-Job $job -Force -ErrorAction SilentlyContinue
    }

    # Kill orphaned claude processes still running in our worktrees
    Stop-AllWorkerProcesses

    # Restore main repo to base branch (merge-review workers may have checked out a PR branch)
    $currentBranch = git -C $MAIN_REPO rev-parse --abbrev-ref HEAD 2>$null
    if ($currentBranch -and $currentBranch -ne $BaseBranch) {
        Write-Log "Restoring main repo from '$currentBranch' to '$BaseBranch'"
        git -C $MAIN_REPO checkout $BaseBranch 2>&1 | Out-Null
    }

    # Move uncompleted claimed tasks back to In Progress
    if ($script:claimedTasks.Count -gt 0) {
        foreach ($taskId in @($script:claimedTasks.Keys)) {
            Move-KanbanTask -RepoPath $MAIN_REPO -TaskId $taskId -Column "In Progress" | Out-Null
            Release-TaskClaim -TaskId $taskId
        }
    }
    $script:claimedSubTasks.Clear()

    # Remove worktrees
    foreach ($w in @($worktrees.Keys)) {
        Remove-RalphWorktree -WorkerId $w
    }
    Remove-MergeWorktree

    # Prune remote+local ralph/* branches (safe now - all worktrees removed, all claims released)
    Prune-MergedRalphBranches

    # Delete remaining local ralph/* branches (push unpushed work first)
    $localBranches = git -C $MAIN_REPO branch --list "ralph/*" 2>$null
    if ($localBranches) {
        foreach ($branchLine in @($localBranches)) {
            $branch = $branchLine.Trim().TrimStart('* ')
            if (-not $branch) { continue }
            if ($branch -match '^ralph/worker-\d+$') { continue }

            # Push any unpushed commits before deleting
            $ahead = git -C $MAIN_REPO log --oneline "origin/${branch}..${branch}" 2>$null
            if (-not $ahead) {
                # No remote tracking - check against master
                $ahead = git -C $MAIN_REPO log --oneline "master..${branch}" 2>$null
            }
            if ($ahead) {
                Write-Log "  Pushing unpushed work on $branch before cleanup"
                git -C $MAIN_REPO push origin "${branch}:${branch}" --force 2>&1 | Out-Null
            }

            git -C $MAIN_REPO branch -D $branch 2>&1 | Out-Null
            Write-Log "  Cleaned up local branch: $branch" "OK"
        }
    }

    # Create PRs for Done tasks whose remote branches lack one
    New-PRsForDoneTasks

    # Prune stale worktree refs
    git -C $MAIN_REPO worktree prune 2>$null | Out-Null
}

Write-Host ""
if ($boardComplete) {
    Write-Host "Kanbn board is complete!" -ForegroundColor Green
} else {
    Write-Host "Completed $totalCompleted total iterations across $Workers workers." -ForegroundColor Cyan
}

} # end Ralph-Loop
