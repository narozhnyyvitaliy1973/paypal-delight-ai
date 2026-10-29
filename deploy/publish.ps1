param([switch]$EnableCloudflareLab)
$ErrorActionPreference = 'Stop'
$deployRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$archive = $null
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
    foreach ($task in @('typecheck','build')) {
        Invoke-Checked 'npm.cmd' @('run', $task)
    }
    $releaseId = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + $sha
    if ($EnableCloudflareLab) {
        Invoke-Checked 'node' @('deploy/prepare-cloudflare.mjs','--check')
        Invoke-Checked 'scp' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','deploy/stage-cloudflare.py','deploy/activate-release.sh','deploy/rollback.sh','deploy/nginx-paypal-delight-ai.conf','root@91.99.101.189:/var/www/paypal-delight-ai/ops/')
        Invoke-Checked 'ssh' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','root@91.99.101.189','chmod 700 /var/www/paypal-delight-ai/ops/stage-cloudflare.py /var/www/paypal-delight-ai/ops/activate-release.sh /var/www/paypal-delight-ai/ops/rollback.sh')
        Invoke-Checked 'node' @('deploy/prepare-cloudflare.mjs','--stage',$releaseId)
    }
    $archive = Join-Path ([IO.Path]::GetTempPath()) "paypal-delight-$releaseId.tar.gz"
    Invoke-Checked 'tar' @('-czf', $archive, 'package.json','package-lock.json','client/package.json','client/dist','server/package.json','server/dist')
    Invoke-Checked 'scp' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',$archive,"root@91.99.101.189:/tmp/paypal-delight-$releaseId.tar.gz")
    Invoke-Checked 'ssh' @('-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','root@91.99.101.189',"/var/www/paypal-delight-ai/ops/activate-release.sh $releaseId /tmp/paypal-delight-$releaseId.tar.gz")
    Write-Output "Published $releaseId. Verify the password-protected HTTPS site."
} finally {
    Pop-Location
    if ($archive -and (Test-Path -LiteralPath $archive)) {
        Remove-Item -LiteralPath $archive -Force -ErrorAction Continue
    }
}
