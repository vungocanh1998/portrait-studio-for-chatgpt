param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination,
  [Parameter(Mandatory = $true)][string]$Replace
)

$ErrorActionPreference = 'Stop'
if ($Replace -notin @('true', 'false')) { throw 'Replace must be true or false.' }

function Add-LongPathPrefix([string]$Path) {
  if ($Path.StartsWith('\\?\', [StringComparison]::Ordinal)) { return $Path }
  if ($Path.StartsWith('\\', [StringComparison]::Ordinal)) { return '\\?\UNC\' + $Path.Substring(2) }
  return '\\?\' + $Path
}

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class OfflineAtomicMove {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool MoveFileExW(string source, string destination, uint flags);

  public static void Move(string source, string destination, bool replace) {
    const uint MOVEFILE_REPLACE_EXISTING = 0x1;
    const uint MOVEFILE_WRITE_THROUGH = 0x8;
    uint flags = MOVEFILE_WRITE_THROUGH | (replace ? MOVEFILE_REPLACE_EXISTING : 0);
    if (!MoveFileExW(source, destination, flags))
      throw new Win32Exception(Marshal.GetLastWin32Error());
  }
}
'@

[OfflineAtomicMove]::Move((Add-LongPathPrefix $Source), (Add-LongPathPrefix $Destination), [bool]::Parse($Replace))

