$ErrorActionPreference = 'Stop'
$deployRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
function Invoke-Checked([string]$program, [string[]]$arguments) {
    & $program @arguments
    if ($LASTEXITCODE -ne 0) { throw "$program failed (exit $LASTEXITCODE)" }
}
Push-Location $deployRoot
try {
    $gitConfig = "safe.directory=$($deployRoot.Replace('\','/'))"
    $changes = & git -c $gitConfig status --porcelain
    if ($LASTEXITCODE -ne 0 -or $changes) { throw 'Commit and review the intended changes before publishing; working tree must be clean.' }
    $branch = & git -c $gitConfig branch --show-current
    if ($branch -ne 'main') { throw 'Publish from main only.' }
    $sha = & git -c $gitConfig rev-parse --short=7 HEAD
    if ($sha -notmatch '^[a-f0-9]{7,40}$') { throw 'Invalid commit SHA.' }
    foreach ($task in @('typecheck','build','test','test:smoke','test:browser')) {
        Invoke-Checked 'npm.cmd' @('run', $task)
    }
    $releaseId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + $sha
    New-Item -ItemType Directory -Path '.npm-cache' -Force | Out-Null
    $archive = ".npm-cache/paypal-delight-$releaseId.tar.gz"
    Invoke-Checked 'tar' @('-czf', $archive, 'package.json','package-lock.json','client/package.json','client/dist','server/package.json','server/dist')
    Invoke-Checked 'scp' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',$archive,"root@91.99.101.189:/tmp/paypal-delight-$releaseId.tar.gz")
    Invoke-Checked 'ssh' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','root@91.99.101.189',"/var/www/paypal-delight-ai/ops/activate-release.sh $releaseId /tmp/paypal-delight-$releaseId.tar.gz")
    Write-Output "Published $releaseId. Verify the password-protected HTTPS site."
} finally { Pop-Location }
