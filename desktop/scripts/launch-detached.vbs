' 以完全分离的方式启动打包应用，使其不随父 shell 退出而被收走。
'
' 为什么需要这个：从 bash / PowerShell 工具启动的进程会随工具调用结束而被
' 终止（工具每次调用都是独立会话），导致 CDP 端口刚开就断，无法做端到端验证。
' WScript.Shell.Run 带 False 参数即「不等待」，进程所有权交给系统。
'
' 用法：wscript //nologo scripts\launch-detached.vbs

Set sh = CreateObject("WScript.Shell")
sh.Run """D:\HarnessTest\desktop\dist\win-unpacked\VRH 视频反推.exe"" --remote-debugging-port=9222", 0, False
