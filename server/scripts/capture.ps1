# Captures the Roblox Studio window to a PNG.
# Usage: capture.ps1 -Out <png> [-Title <substring>] [-Dll <compiled helper path>]
# Prints one line of JSON: {"ok":true,"width":..,"height":..,"title":".."} or {"ok":false,"error":".."}
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Title = "",
  [string]$Dll = ""
)
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$source = @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;

public static class RoLinkCapture {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  static string TitleOf(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }

  public static string Capture(string outPath, string want) {
    SetProcessDPIAware();
    var pids = new HashSet<uint>();
    foreach (var p in Process.GetProcessesByName("RobloxStudioBeta")) pids.Add((uint)p.Id);
    if (pids.Count == 0) return "{\"ok\":false,\"error\":\"Roblox Studio is not running\"}";

    IntPtr best = IntPtr.Zero; IntPtr any = IntPtr.Zero; int bestArea = 0;
    EnumWindows((h, _) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!pids.Contains(pid) || !IsWindowVisible(h)) return true;
      string t = TitleOf(h);
      if (!t.Contains("Roblox Studio")) return true;
      RECT r; GetWindowRect(h, out r);
      int area = (r.R - r.L) * (r.B - r.T);
      if (want.Length > 0 && t.IndexOf(want, StringComparison.OrdinalIgnoreCase) >= 0) {
        if (area > bestArea) { best = h; bestArea = area; }
      } else if (any == IntPtr.Zero) any = h;
      return true;
    }, IntPtr.Zero);
    IntPtr hwnd = best != IntPtr.Zero ? best : any;
    if (hwnd == IntPtr.Zero) return "{\"ok\":false,\"error\":\"Studio window not found\"}";

    if (IsIconic(hwnd)) { ShowWindow(hwnd, 4 /* SHOWNOACTIVATE */); System.Threading.Thread.Sleep(400); }
    if (IsIconic(hwnd)) { ShowWindow(hwnd, 9 /* RESTORE */); System.Threading.Thread.Sleep(600); }

    RECT rc; GetWindowRect(hwnd, out rc);
    int w = rc.R - rc.L, hgt = rc.B - rc.T;
    if (w <= 0 || hgt <= 0) return "{\"ok\":false,\"error\":\"window has no size\"}";

    var bmp = new Bitmap(w, hgt, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr hdc = g.GetHdc();
      bool ok = PrintWindow(hwnd, hdc, 2 /* PW_RENDERFULLCONTENT */);
      g.ReleaseHdc(hdc);
      if (!ok || MostlyBlack(bmp)) {
        g.CopyFromScreen(rc.L, rc.T, 0, 0, new Size(w, hgt));
      }
    }
    bmp.Save(outPath, ImageFormat.Png);
    bmp.Dispose();
    string title = TitleOf(hwnd).Replace("\\", "\\\\").Replace("\"", "\\\"");
    return "{\"ok\":true,\"width\":" + w + ",\"height\":" + hgt + ",\"title\":\"" + title + "\"}";
  }

  static bool MostlyBlack(Bitmap b) {
    int dark = 0, n = 0;
    for (int y = b.Height / 4; y < b.Height * 3 / 4; y += Math.Max(1, b.Height / 24))
      for (int x = b.Width / 4; x < b.Width * 3 / 4; x += Math.Max(1, b.Width / 24)) {
        var c = b.GetPixel(x, y); n++;
        if (c.R < 6 && c.G < 6 && c.B < 6) dark++;
      }
    return n > 0 && dark > n * 0.97;
  }
}
"@

try {
  if (-not ("RoLinkCapture" -as [type])) {
    if ($Dll -and (Test-Path $Dll)) {
      Add-Type -Path $Dll
    } elseif ($Dll) {
      Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing -OutputAssembly $Dll
      Add-Type -Path $Dll
    } else {
      Add-Type -TypeDefinition $source -ReferencedAssemblies System.Drawing
    }
  }
  [Console]::Out.WriteLine([RoLinkCapture]::Capture($Out, $Title))
} catch {
  $msg = $_.Exception.Message -replace '\\', '\\' -replace '"', '\"' -replace "`r|`n", ' '
  [Console]::Out.WriteLine("{""ok"":false,""error"":""$msg""}")
}
