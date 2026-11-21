# Runner-side guard (ACTIONS_RUNNER_HOOK_JOB_STARTED) of winvm's ephemeral runner (winvm-runner.sh), the Windows
# counterpart of job-started.sh: it runs before every job, outside anything a workflow controls. A pull request's run
# executes its own workflow files and route script, so a fork could name this runner's label; every job whose code
# comes from another repository is refused before a step runs. Fails closed: an error of this script refuses too.
# An allowed job then has the VM to itself: the VM's other runner services (other repositories' runners kept in the
# snapshot) are stopped while idle; the reset after the job starts them again. One that is already in a job goes on,
# and winvm-runner.sh waits for it before that reset.
$ErrorActionPreference = 'Stop'
$repository = $env:GITHUB_REPOSITORY
$eventName = $env:GITHUB_EVENT_NAME
$parent = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId
$verdict = $null
try {
    $payload = Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH | ConvertFrom-Json
    $head = if ($eventName -like 'pull_request*' -or $payload.pull_request) { $payload.pull_request.head.repo.full_name }
    elseif ($eventName -eq 'workflow_run' -or $payload.workflow_run) { $payload.workflow_run.head_repository.full_name }
    elseif ($eventName -eq 'issue_comment') { if ($payload.issue -and $payload.comment) { $repository } }
    else { $repository }
    $verdict = if ($repository -and $head -eq $repository) { 'allow' } elseif ($head) { "its code comes from $head" } else { 'its code comes from an unknown repository' }
} catch {
    $verdict = "the guard failed: $_"
}
if ($verdict -ne 'allow') {
    Write-Output "::error::winvm's runner only runs code from $repository; refusing this $eventName job: $verdict."
    $worker = Get-Process -Id $parent -ErrorAction SilentlyContinue
    if ($worker -and $worker.ProcessName -eq 'Runner.Worker') { Stop-Process -Id $parent -Force }
    exit 1
}
Write-Output "Runner guard: $eventName from $repository"
$busy = @(Get-Process -Name Runner.Worker -ErrorAction SilentlyContinue | Where-Object Id -ne $parent | ForEach-Object { Split-Path (Split-Path $_.Path) })
Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner.%' AND State = 'Running'" | ForEach-Object {
    $dir = Split-Path (Split-Path $_.PathName.Trim('"'))
    if ($busy -contains $dir) {
        Write-Output "::warning::$($_.Name) is in a job of its own; it goes on beside this one"
    } else {
        Stop-Service -Name $_.Name
        Write-Output "Stopped $($_.Name) for this job"
    }
}
