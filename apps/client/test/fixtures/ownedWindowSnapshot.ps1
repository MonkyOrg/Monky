param([Parameter(Mandatory = $true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedWindowSnapshot {
  public delegate bool EnumCallback(IntPtr handle, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr param);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rect);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr handle, StringBuilder name, int count);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
}
'@
if (![OwnedWindowSnapshot]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
  throw 'Could not obtain physical window coordinates.'
}
$rows = [System.Collections.Generic.List[object]]::new()
$callback = [OwnedWindowSnapshot+EnumCallback]{
  param([IntPtr]$Handle, [IntPtr]$Param)
  [uint32]$ownerId = 0
  [void][OwnedWindowSnapshot]::GetWindowThreadProcessId($Handle, [ref]$ownerId)
  if ($ownerId -ne $ProcessId) { return $true }
  $name = [System.Text.StringBuilder]::new(256)
  [void][OwnedWindowSnapshot]::GetClassName($Handle, $name, $name.Capacity)
  if ($name.ToString() -notlike 'Chrome_WidgetWin_*') { return $true }
  $rect = [OwnedWindowSnapshot+Rect]::new()
  if (![OwnedWindowSnapshot]::GetWindowRect($Handle, [ref]$rect)) {
    throw 'Could not read an owned Chromium window.'
  }
  $rows.Add(@{
    handle = $Handle.ToInt64()
    visible = [OwnedWindowSnapshot]::IsWindowVisible($Handle)
    x = $rect.Left; y = $rect.Top
    width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top
  })
  return $true
}
if (![OwnedWindowSnapshot]::EnumWindows($callback, [IntPtr]::Zero)) {
  throw 'Could not enumerate owned windows.'
}
ConvertTo-Json -InputObject @($rows.ToArray()) -Compress
