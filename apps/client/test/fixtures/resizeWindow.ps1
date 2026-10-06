param([long]$Handle, [int]$Edge, [int]$Left, [int]$Top, [int]$Width, [int]$Height,
  [int]$AreaLeft, [int]$AreaTop, [int]$AreaWidth, [int]$AreaHeight, [int]$Steps = 1)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OwnedResize {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
 [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect r);
 [DllImport("user32.dll", EntryPoint="SendMessageW")] public static extern IntPtr SendRect(IntPtr h, uint m, IntPtr w, ref Rect r);
 [DllImport("user32.dll", EntryPoint="SendMessageW")] public static extern IntPtr Send(IntPtr h, uint m, IntPtr w, IntPtr p);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int t, uint flags);
}
'@
if (![OwnedResize]::SetProcessDpiAwarenessContext([IntPtr](-4))) { throw 'Could not obtain physical coordinates.' }
$rect = [OwnedResize+Rect]::new()
$h=[IntPtr]$Handle
$initial = [OwnedResize+Rect]::new()
if (![OwnedResize]::GetWindowRect($h,[ref]$initial)) { throw 'Owned window bounds unavailable.' }
$trace = [System.Collections.Generic.List[object]]::new()
[void][OwnedResize]::Send($h,0x231,[IntPtr]::Zero,[IntPtr]::Zero)
try {
  for ($step = 1; $step -le $Steps; $step++) {
    $t = $step / $Steps
    $rect.Left = [Math]::Round($initial.Left + ($Left - $initial.Left) * $t)
    $rect.Top = [Math]::Round($initial.Top + ($Top - $initial.Top) * $t)
    $rect.Right = [Math]::Round($initial.Right + ($Left + $Width - $initial.Right) * $t)
    $rect.Bottom = [Math]::Round($initial.Bottom + ($Top + $Height - $initial.Bottom) * $t)
    [void][OwnedResize]::SendRect($h,0x214,[IntPtr]$Edge,[ref]$rect)
    if ($rect.Left -lt $AreaLeft -or $rect.Top -lt $AreaTop -or $rect.Right -gt ($AreaLeft+$AreaWidth) -or $rect.Bottom -gt ($AreaTop+$AreaHeight)) {
      throw "Native resize escaped the verified test monitor: $($rect | ConvertTo-Json -Compress)"
    }
    if (![OwnedResize]::SetWindowPos($h,[IntPtr]::Zero,$rect.Left,$rect.Top,$rect.Right-$rect.Left,$rect.Bottom-$rect.Top,0x14)) {
      throw 'Could not apply the native sizing result.'
    }
    $trace.Add(@{x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top})
    if ($Steps -gt 1) { Start-Sleep -Milliseconds 32 }
  }
} finally {
  [void][OwnedResize]::Send($h,0x232,[IntPtr]::Zero,[IntPtr]::Zero)
}
@{x=$rect.Left;y=$rect.Top;width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top;trace=$trace} | ConvertTo-Json -Compress -Depth 4
