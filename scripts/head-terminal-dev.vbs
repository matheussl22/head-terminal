Option Explicit
' Launches Head Terminal in dev mode without flashing a console window.
' Pin this via the Start Menu shortcut — not electron.exe itself.
Dim fso, sh, root, nodeDir, gitDir, procPath
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root

nodeDir = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs"
gitDir = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Git\cmd"
procPath = sh.Environment("Process")("PATH")
sh.Environment("Process")("PATH") = nodeDir & ";" & gitDir & ";" & procPath

If Not fso.FolderExists(root & "\node_modules") Then
  MsgBox "Dependencias ausentes. Rode npm install no projeto.", 16, "Head Terminal"
  WScript.Quit 1
End If

sh.Run "cmd /c npm run dev", 0, False
