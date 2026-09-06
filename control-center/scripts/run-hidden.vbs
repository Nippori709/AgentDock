Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 2 Then WScript.Quit 2

nodePath = WScript.Arguments(0)
scriptPath = WScript.Arguments(1)
command = Chr(34) & nodePath & Chr(34) & " " & Chr(34) & scriptPath & Chr(34)

For i = 2 To WScript.Arguments.Count - 1
  command = command & " " & Chr(34) & Replace(WScript.Arguments(i), Chr(34), Chr(34) & Chr(34)) & Chr(34)
Next

shell.Run command, 0, False
