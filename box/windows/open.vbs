' Three O'Clock desktop icon. Runs open.ps1 with no window. P62.
Dim shell, folder, page
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
page = ""
If WScript.Arguments.Count > 0 Then page = WScript.Arguments(0)
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & folder & "\open.ps1"" -Page """ & page & """", 0, False
