# 启动打包后的应用（带调试端口），并等待其就绪。
#
# 用 Start-Process 而非后台 & ：bash 的后台进程会随 shell 退出被收走，
# 导致 CDP 端口刚开就断。Start-Process 是真正的分离进程。
#
# NODE_OPTIONS 必须清掉：当前环境注入了 IDE 的 language shim，
# Electron 打包应用检测到它会直接拒绝启动（不是应用的问题）。

$exe = "D:\HarnessTest\desktop\dist\win-unpacked\VRH 视频反推.exe"
$logDir = "D:\HarnessTest\desktop"

# 清掉继承来的 NODE_OPTIONS
Remove-Item Env:\NODE_OPTIONS -ErrorAction SilentlyContinue

$p = Start-Process -FilePath $exe `
  -ArgumentList "--remote-debugging-port=9222" `
  -RedirectStandardOutput "$logDir\pkg-run.log" `
  -RedirectStandardError "$logDir\pkg-run.err" `
  -PassThru

Write-Output "已启动，PID=$($p.Id)"

# 等 CDP 端口就绪（最多 40 秒）
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:9222/json/version" -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch { }
}

if ($ready) {
  Write-Output "CDP 端口已就绪（等待 $($i+1) 秒）"
} else {
  Write-Output "CDP 端口未就绪"
  if (Test-Path "$logDir\pkg-run.err") {
    Get-Content "$logDir\pkg-run.err" | Select-Object -First 10
  }
}
