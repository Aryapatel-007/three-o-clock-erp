' Three O'Clock print window. Runs print-agent.ps1 with no window, for the "ThreeOClock Printer" task.
Dim shell, folder
Set shell = CreateObject("WScript.Shell")
folder = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & folder & "\print-agent.ps1""", 0, False
