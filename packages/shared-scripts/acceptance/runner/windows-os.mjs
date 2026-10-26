// Importing this module never starts PowerShell, Python, Electron or an installer.
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  assertHostedRunner,
  assertWithinWindows,
  installerArguments,
  childEnvironment,
  parseInstallerJsonl,
  assertInstallerSuccess,
  selectOwnedProcesses,
} from '../windows-upgrade-contract.mjs';
import {
  installedIdentity,
  ordinaryQuit,
  installUpdaterFixture,
  nativeFixtureCheck,
  snapshotUpdaterEvents,
  snapshotInstallAudit,
  invokeProvider,
  readDownloadedUpdate,
  suspendDownloadedUpdate,
  inspectSynchronousHandoffRejection,
  restoreDownloadedUpdate,
  invokeInstallAndObserveError,
} from '../windows-installed-app-hook.mjs';
import { installedBackendRequest } from '../windows-installed-seed.mjs';

export function assertUnambiguousWindowsPath(value) {
  // Windows paths must reject control characters before shell and process use.
  // eslint-disable-next-line no-control-regex
  if (typeof value !== 'string' || !/^[a-z]:\\/i.test(value) || /["\r\n\x00]/.test(value))
    throw Error('Expected an absolute Windows filesystem path');
  for (const part of value.slice(3).split(/[\\/]/)) {
    if (
      !part ||
      part === '.' ||
      part === '..' ||
      /[:*?<>|]/.test(part) ||
      /[. ]$/.test(part) ||
      /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)
    )
      throw Error('Ambiguous Windows path segment');
  }
  return path.win32.normalize(value);
}
const samePath = (a, b) => path.win32.normalize(a).toLowerCase() === path.win32.normalize(b).toLowerCase();
const sameProcess = (a, b) => selectOwnedProcesses([a], [b]).length === 1;

export function isInstalledMediaChild(record, main, expectedScript) {
  if (
    !sameProcess(record, record) ||
    sameProcess(record, main) ||
    Number(record.parentPid) !== Number(main.pid) ||
    !main.sid ||
    record.sid !== main.sid ||
    !samePath(record.executable, main.executable) ||
    !(Date.parse(record.created) >= Date.parse(main.created))
  )
    return false;
  try {
    const args = windowsArguments(record.commandLine);
    // Reviewed packaged MediaServiceProcess launches exactly execPath + script.
    // OS evidence does not expose or prove ELECTRON_RUN_AS_NODE child env.
    return (
      args.length === 2 &&
      samePath(assertUnambiguousWindowsPath(args[0]), main.executable) &&
      samePath(assertUnambiguousWindowsPath(args[1]), assertUnambiguousWindowsPath(expectedScript))
    );
  } catch {
    return false;
  }
}

export function collectOwnedDescendants(snapshot, registry, allowedExecutables) {
  const live = selectOwnedProcesses(snapshot, registry);
  const added = [];
  for (;;) {
    const found = snapshot.filter(
      (p) =>
        ![...live, ...added].some((o) => sameProcess(p, o)) &&
        allowedExecutables.some((e) => samePath(e, p.executable ?? '')) &&
        [...live, ...added].some(
          (parent) => Number(p.parentPid) === Number(parent.pid) && Date.parse(p.created) >= Date.parse(parent.created)
        )
    );
    if (!found.length) return added;
    added.push(...found);
  }
}

// A handoff may register a downloaded installer and its new main. Neither is
// part of the old launch's normal-exit obligation, even when the exe is equal.
export function registeredLaunchTree(registry, main, installedExecutables) {
  const tree = [main];
  for (;;) {
    const next = registry.filter(
      (p) =>
        !tree.some((t) => sameProcess(t, p)) &&
        installedExecutables.some((file) => samePath(file, p.executable)) &&
        tree.some(
          (parent) => Number(p.parentPid) === Number(parent.pid) && Date.parse(p.created) >= Date.parse(parent.created)
        )
    );
    if (!next.length) return tree;
    tree.push(...next);
  }
}

// CommandLineToArgvW-compatible quote/backslash handling for ordinary argv.
function windowsArguments(commandLine) {
  if (typeof commandLine !== 'string') throw Error('Missing actual backend command line');
  const args = [];
  let i = 0;
  while (i < commandLine.length) {
    while (/\s/.test(commandLine[i] ?? '') && i < commandLine.length) i++;
    if (i >= commandLine.length) break;
    let arg = '';
    let quoted = false;
    while (i < commandLine.length && (quoted || !/\s/.test(commandLine[i]))) {
      let slashes = 0;
      while (commandLine[i] === '\\') {
        slashes++;
        i++;
      }
      if (commandLine[i] === '"') {
        arg += '\\'.repeat(Math.floor(slashes / 2));
        if (slashes % 2) arg += '"';
        else quoted = !quoted;
        i++;
      } else {
        arg += '\\'.repeat(slashes);
        if (i < commandLine.length && (quoted || !/\s/.test(commandLine[i]))) arg += commandLine[i++];
      }
    }
    if (quoted) throw Error('Unterminated Windows command line quote');
    args.push(arg);
  }
  return args;
}
export function backendDataDirectory(commandLine) {
  const args = windowsArguments(commandLine);
  const indices = args.flatMap((arg, index) => (arg === '--data-dir' || arg.startsWith('--data-dir=') ? [index] : []));
  if (indices.length !== 1 || !args.includes('--local'))
    throw Error('Expected one actual backend --data-dir and --local');
  const index = indices[0];
  return assertUnambiguousWindowsPath(args[index].startsWith('--data-dir=') ? args[index].slice(11) : args[index + 1]);
}
export function backendPort(commandLine) {
  const args = windowsArguments(commandLine);
  const indices = args.flatMap((arg, index) => (arg === '--port' || arg.startsWith('--port=') ? [index] : []));
  if (indices.length !== 1) throw Error('Expected exactly one actual backend port');
  const index = indices[0];
  const value = args[index].startsWith('--port=') ? args[index].slice(7) : args[index + 1];
  if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 65535)
    throw Error('Invalid actual backend port');
  return Number(value);
}

// Fixed script. All variable data is transported as base64 JSON in one env var.
const POWERSHELL = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:OPENH3_ACCEPTANCE_PAYLOAD)) | ConvertFrom-Json
function Emit($v) { [Console]::Out.WriteLine(($v | ConvertTo-Json -Depth 30 -Compress)); [Console]::Out.Flush() }
function CheckPath([string]$value, [bool]$create, [bool]$missingLeaf) {
  $full = [IO.Path]::GetFullPath($value)
  if ($full -notmatch '^[A-Za-z]:\\') { throw 'Not a drive absolute path' }
  $current = [IO.Path]::GetPathRoot($full)
  $segments = $full.Substring($current.Length).Split('\')
  $all = @($current)
  foreach ($segment in $segments) { if ($segment) { $current = [IO.Path]::Combine($current,$segment); $all += $current } }
  for ($i=0; $i -lt $all.Length; $i++) {
    $item = $null
    try { $item = Get-Item -LiteralPath $all[$i] -Force -ErrorAction Stop } catch [System.Management.Automation.ItemNotFoundException] {
      if ($create) { [void][IO.Directory]::CreateDirectory($all[$i]); $item = Get-Item -LiteralPath $all[$i] -Force }
      elseif ($missingLeaf -and $i -eq $all.Length-1) { return }
      else { throw }
    }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point ancestor/target rejected' }
    if ($i -lt $all.Length-1 -and -not $item.PSIsContainer) { throw 'Non-directory ancestor' }
  }
}
function Record($proc,$cim) {
  [void]$proc.Handle
  $proc.Refresh()
  $start = $proc.StartTime.ToUniversalTime()
  $image = $proc.MainModule.FileName
  if (-not $cim) { $cim = Get-CimInstance Win32_Process -Filter ('ProcessId = '+$proc.Id) }
  if ($cim -and [Math]::Abs(($cim.CreationDate.ToUniversalTime()-$start).TotalMilliseconds) -gt 5) { throw 'PID changed during snapshot' }
  if (-not $cim) { throw 'Live identity requires CIM owner/command line' }
  $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwnerSid
  if ($owner.ReturnValue -ne 0 -or -not $owner.Sid) { throw 'Cannot prove process owner SID' }
  return @{ pid=$proc.Id; created=$start.ToString('o'); ticks=$start.Ticks.ToString(); executable=$image; sid=$owner.Sid; parentPid=$cim.ParentProcessId; commandLine=$cim.CommandLine }
}
function Snapshot {
  $result = @()
  foreach ($c in @(Get-CimInstance Win32_Process)) {
    $registered = @($p.registry | Where-Object { [int]$_.pid -eq [int]$c.ProcessId }).Length -gt 0
    if (-not $c.ExecutablePath -and -not $registered) { continue }
    if (-not $registered -and -not (@($p.allowedExecutables) | Where-Object { [String]::Equals($_,$c.ExecutablePath,[StringComparison]::OrdinalIgnoreCase) })) { continue }
    $proc = $null
    try { $proc=[Diagnostics.Process]::GetProcessById($c.ProcessId); $result += (Record $proc $c) } catch {
      if (@($p.registry) | Where-Object { [int]$_.pid -eq [int]$c.ProcessId }) {
        if ($proc -and -not $proc.HasExited) { throw 'Cannot establish identity of a still-live registered process' }
      }
    } finally { if($proc){$proc.Dispose()} }
  }
  # Missing CIM rows/images cannot masquerade as proof of a registered exit.
  foreach ($r in @($p.registry)) {
    if (@($result | Where-Object { [int]$_.pid -eq [int]$r.pid }).Length) { continue }
    $proc = $null
    try {
      $proc = [Diagnostics.Process]::GetProcessById([int]$r.pid)
      $actual = Record $proc $null
      if ($actual.created -eq $r.created -and [String]::Equals($actual.executable,$r.executable,[StringComparison]::OrdinalIgnoreCase)) { $result += $actual }
    } catch {
      if ($proc -and -not $proc.HasExited) { throw 'Cannot prove registered process exited after missing CIM row' }
    } finally { if($proc){$proc.Dispose()} }
  }
  return $result
}
switch ($p.action) {
  'path' { CheckPath $p.path ([bool]$p.create) ([bool]$p.missingLeaf); Emit @{kind='result'} }
  'snapshot' { Emit @{kind='result'; processes=@(Snapshot)} }
  'executables' {
    CheckPath $p.path $false $false
    $pending = [Collections.Generic.Queue[string]]::new()
    $pending.Enqueue($p.path)
    $executables = @()
    while ($pending.Count) {
      $directory = $pending.Dequeue()
      foreach ($item in @(Get-ChildItem -LiteralPath $directory -Force)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Installed reparse point rejected' }
        if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
        elseif ($item.Extension -ieq '.exe') { $executables += $item.FullName }
      }
    }
    Emit @{kind='result'; executables=$executables}
  }
  'listeners' { Emit @{kind='result'; pids=@(Get-NetTCPConnection -State Listen -LocalPort $p.port | Select-Object -ExpandProperty OwningProcess -Unique)} }
  'signature' {
    CheckPath $p.path $false $false
    $signature = Get-AuthenticodeSignature -LiteralPath $p.path
    Emit @{kind='result'; status=$signature.Status.ToString(); subject=$signature.SignerCertificate.Subject; thumbprint=$signature.SignerCertificate.Thumbprint}
  }
  'exit-watch' {
    $handles = @(); $exits = @(); $complete = $false
    try {
      foreach ($r in @($p.registry)) {
        $proc = [Diagnostics.Process]::GetProcessById([int]$r.pid)
        $handles += @{ process=$proc; record=$r; reported=$false }
        $actual = Record $proc $null
        if ($actual.created -ne $r.created -or $actual.ticks -ne $r.ticks -or $actual.sid -ne $r.sid -or -not [String]::Equals($actual.executable,$r.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Exit watcher process identity mismatch' }
      }
      Emit @{kind='ready'; retained=@($p.registry)}
      $deadline = [DateTime]::UtcNow.AddMinutes(10)
      while ([DateTime]::UtcNow -lt $deadline) {
        foreach ($h in $handles) {
          if (-not $h.reported -and $h.process.HasExited) {
            $h.process.WaitForExit()
            $e = @{pid=$h.record.pid; created=$h.record.created; ticks=$h.record.ticks; executable=$h.record.executable; exitCode=$h.process.ExitCode; exited=$h.process.ExitTime.ToUniversalTime().ToString('o')}
            $exits += $e; $h.reported = $true; Emit @{kind='exit'; record=$e}
          }
        }
        if ($exits.Length -eq $handles.Length) { $complete=$true; break }
        if ([IO.File]::Exists($p.stopFile)) { break }
        Start-Sleep -Milliseconds 50
      }
      Emit @{kind='result'; completed=$complete; exits=$exits}
    } finally { foreach($h in $handles){ $h.process.Dispose() } }
  }
  'handoff-watch' {
    # This is a specific native-handoff observer, NOT a lossless OS trace.
    CheckPath $p.installerPath $false $false
    CheckPath $p.nsisTemp $false $false
    if ((Get-FileHash -LiteralPath $p.installerPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $p.sha256) { throw 'Prepared native installer hash changed' }
    $handles = @(); $complete = $false
    try {
      foreach ($r in @($p.registry)) {
        $proc = [Diagnostics.Process]::GetProcessById([int]$r.pid)
        $handles += @{ process=$proc; record=$r; role='old-launch'; reported=$false }
        $actual = Record $proc $null
        if ($actual.created -ne $r.created -or $actual.ticks -ne $r.ticks -or $actual.sid -ne $r.sid -or -not [String]::Equals($actual.executable,$r.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Handoff root identity mismatch' }
      }
      Emit @{kind='ready'; retained=@($p.registry)}
      $deadline = [DateTime]::UtcNow.AddMinutes(10)
      $tempPrefix = ([string]$p.nsisTemp).TrimEnd('\')+'\'
      while ([DateTime]::UtcNow -lt $deadline -and -not [IO.File]::Exists($p.stopFile)) {
        foreach ($c in @(Get-CimInstance Win32_Process)) {
          if (-not $c.ExecutablePath) { continue }
          $isInstaller = [String]::Equals($c.ExecutablePath,$p.installerPath,[StringComparison]::OrdinalIgnoreCase)
          $isTemp = $c.ExecutablePath.StartsWith($tempPrefix,[StringComparison]::OrdinalIgnoreCase)
          $isRestart = [String]::Equals($c.ExecutablePath,$p.executablePath,[StringComparison]::OrdinalIgnoreCase) -and $c.CommandLine -match '(?:^|\s)--updated(?:\s|$)' -and $c.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)'
          if (-not ($isInstaller -or $isTemp -or $isRestart)) { continue }
          if (@($handles | Where-Object { [int]$_.record.pid -eq [int]$c.ProcessId -and [Math]::Abs(($_.process.StartTime.ToUniversalTime()-$c.CreationDate.ToUniversalTime()).TotalMilliseconds) -le 5 }).Length) { continue }
          $proc = $null
          try {
            $proc = [Diagnostics.Process]::GetProcessById([int]$c.ProcessId)
            $r = Record $proc $c
            if ($r.sid -ne $p.sid -or [DateTime]::Parse($r.created).ToUniversalTime() -lt [DateTime]::Parse($p.started).ToUniversalTime()) { continue }
            $parents = @($handles | Where-Object {
              if ([int]$_.record.pid -ne [int]$r.parentPid -or [DateTime]::Parse($r.created).ToUniversalTime() -lt $_.process.StartTime.ToUniversalTime()) { return $false }
              if ($_.process.HasExited -and [DateTime]::Parse($r.created).ToUniversalTime() -gt $_.process.ExitTime.ToUniversalTime()) { return $false }
              return $true
            })
            $role = $null
            if ($isInstaller -and $parents.Length -eq 1 -and $parents[0].record.pid -eq $p.mainPid) { $role='installer' }
            elseif ($isTemp -and $parents.Length -eq 1 -and $parents[0].role -in 'installer','nsis-installer') { $role='nsis-installer' }
            elseif ($isRestart) { $role='restart-candidate' }
            if (-not $role) { continue }
            CheckPath $r.executable $false $false
            if ($role -ne 'restart-candidate') {
              $actualHash = (Get-FileHash -LiteralPath $r.executable -Algorithm SHA256).Hash.ToLowerInvariant()
              if ($role -eq 'installer' -and $actualHash -ne $p.sha256) { throw 'Observed native installer bytes changed' }
              if ($role -eq 'nsis-installer' -and ([IO.Path]::GetFileName($r.executable) -notin 'old-uninstaller.exe','AionUi-fixed-uninstaller.exe' -or $actualHash -ne $p.uninstallerSha256)) { throw 'Unknown native installer helper image or bytes' }
              $r.sha256 = $actualHash
            }
            $handles += @{process=$proc; record=$r; role=$role; reported=$false}; $proc=$null
            if ($role -eq 'restart-candidate') { Emit @{kind='restart-candidate'; record=$r; directOwnedParent=($parents.Length -eq 1)} }
            else { Emit @{kind='observed'; role=$role; record=$r} }
          } catch { Emit @{kind='observation-gap'; pid=$c.ProcessId; executable=$c.ExecutablePath; error=$_.Exception.Message} }
          finally { if ($proc) { $proc.Dispose() } }
        }
        foreach ($h in $handles) {
          if (-not $h.reported -and $h.process.HasExited) {
            $h.process.WaitForExit(); $h.reported=$true
            $e = @{pid=$h.record.pid; created=$h.record.created; ticks=$h.record.ticks; executable=$h.record.executable; sid=$h.record.sid; parentPid=$h.record.parentPid; commandLine=$h.record.commandLine}
            $e.exitCode=$h.process.ExitCode; $e.exited=$h.process.ExitTime.ToUniversalTime().ToString('o')
            Emit @{kind='process-exit'; role=$h.role; record=$e}
          }
        }
        Start-Sleep -Milliseconds 50
      }
      $complete = [IO.File]::Exists($p.stopFile)
      Emit @{kind='result'; completed=$complete}
    } finally { foreach ($h in $handles) { $h.process.Dispose() } }
  }
  { $_ -in 'window','close-window' } {
    $r=$p.record; $proc=[Diagnostics.Process]::GetProcessById([int]$r.pid)
    try {
      $actual=Record $proc $null
      if ($actual.created -ne $r.created -or $actual.ticks -ne $r.ticks -or $actual.sid -ne $r.sid -or -not [String]::Equals($actual.executable,$r.executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Window operation identity mismatch' }
      Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class AcceptanceWindow { [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }'
      $proc.Refresh(); $hwnd=$proc.MainWindowHandle; $windowProcessId=[uint32]0
      [void][AcceptanceWindow]::GetWindowThreadProcessId($hwnd,[ref]$windowProcessId)
      $visible=$hwnd -ne [IntPtr]::Zero -and [AcceptanceWindow]::IsWindowVisible($hwnd) -and $windowProcessId -eq $proc.Id
      if ($p.action -eq 'window') { Emit @{kind='result'; visible=$visible; hwnd=$hwnd.ToInt64().ToString(); record=$actual} }
      else {
        if (-not $visible -or $hwnd.ToInt64().ToString() -ne [string]$p.hwnd) { throw 'Owned visible HWND changed before WM_CLOSE' }
        if (-not $proc.CloseMainWindow()) { throw 'Owned main window rejected normal WM_CLOSE request' }
        Emit @{kind='result'; requested=$true; hwnd=$hwnd.ToInt64().ToString()}
      }
    } finally { $proc.Dispose() }
  }
  { $_ -in 'cdn-enable','cdn-disable' } {
    $hosts = [IO.Path]::Combine($env:SystemRoot,'System32\drivers\etc\hosts')
    CheckPath $hosts $false $false
    $latin = [Text.Encoding]::GetEncoding(28591)
    $text = $latin.GetString([IO.File]::ReadAllBytes($hosts))
    $first = $text.IndexOf([string]$p.block,[StringComparison]::Ordinal)
    if ($p.action -eq 'cdn-enable') {
      if ($first -ge 0) { throw 'Owned hosts block already exists; refusing ambiguous ownership' }
      [IO.File]::AppendAllText($hosts,[string]$p.block,$latin)
      # Publish restoration ownership before any following operation can fail.
      Emit @{kind='cdn-written'; hosts=$hosts}
    } else {
      if ($first -lt 0) { Emit @{kind='result'; hosts=$hosts; restored=$false; reason='Own exact block absent; no write performed'}; break }
      if ($text.IndexOf([string]$p.block,$first+1,[StringComparison]::Ordinal) -ge 0) { throw 'Duplicate own hosts block' }
      [IO.File]::WriteAllBytes($hosts,$latin.GetBytes($text.Remove($first,([string]$p.block).Length)))
    }
    & "$env:SystemRoot\System32\ipconfig.exe" /flushdns | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'DNS cache flush failed' }
    if ($p.action -eq 'cdn-enable') {
      $addresses = @([Net.Dns]::GetHostAddresses('static.aionui.com') | ForEach-Object { $_.ToString() })
      if (-not $addresses.Length -or @($addresses | Where-Object { $_ -notin '0.0.0.0','::' }).Length) { throw 'Legacy CDN hostname is not confined to hosts deny addresses' }
      Emit @{kind='result'; hosts=$hosts; enabled=$true; addresses=$addresses; attemptsMonitored=$false}
    } else { Emit @{kind='result'; hosts=$hosts; restored=$true} }
  }
  'install' {
    CheckPath $p.installerPath $false $false
    CheckPath $p.installDir $true $false
    CheckPath ([IO.Path]::GetDirectoryName($p.logPath)) $true $false
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $p.installerPath
    $start.Arguments = $p.arguments
    $start.UseShellExecute = $false
    $start.WorkingDirectory = [IO.Path]::GetDirectoryName($p.installerPath)
    $start.EnvironmentVariables.Clear()
    foreach ($property in $p.childEnv.PSObject.Properties) { $start.EnvironmentVariables[$property.Name] = [string]$property.Value }
    $proc = [Diagnostics.Process]::Start($start)
    try {
      $cim = Get-CimInstance Win32_Process -Filter ('ProcessId = '+$proc.Id)
      $record = Record $proc $cim
      if (-not [String]::Equals($record.executable,$p.installerPath,[StringComparison]::OrdinalIgnoreCase)) { throw 'Started installer identity mismatch' }
      Emit @{kind='started'; record=$record}
      if (-not $proc.WaitForExit(600000)) { throw 'Installer exceeded 10 minute wait; no forced kill here' }
      Emit @{kind='result'; pid=$record.pid; created=$record.created; ticks=$record.ticks; executable=$record.executable; sid=$record.sid; exitCode=$proc.ExitCode}
    } finally { $proc.Dispose() }
  }
  'cleanup' {
    $cleaned = @()
    $cleanupErrors = @()
    foreach ($r in @($p.registry)) {
      $proc=$null
      try {
        try { $proc=[Diagnostics.Process]::GetProcessById([int]$r.pid) } catch [ArgumentException] { continue }
        [void]$proc.Handle
        $actual=Record $proc $null
        if ($actual.created -ne $r.created -or $actual.ticks -ne $r.ticks -or -not $r.sid -or $actual.sid -ne $r.sid -or -not [String]::Equals($actual.executable,$r.executable,[StringComparison]::OrdinalIgnoreCase)) { continue }
        if (-not (@($p.allowedExecutables) | Where-Object { [String]::Equals($_,$actual.executable,[StringComparison]::OrdinalIgnoreCase) })) { throw 'Cleanup executable not explicitly allowlisted' }
        CheckPath $actual.executable $false $false
        $proc.Kill()
        if (-not $proc.WaitForExit(30000)) { throw 'Owned process did not exit during cleanup' }
        $cleaned += $r
      } catch {
        $cleanupErrors += @{pid=$r.pid; created=$r.created; executable=$r.executable; error=$_.Exception.Message}
      } finally {
        if ($proc) {
          try { $proc.Dispose() } catch {
            $cleanupErrors += @{pid=$r.pid; created=$r.created; executable=$r.executable; error=$_.Exception.Message}
          }
        }
      }
    }
    Emit @{kind='result'; cleaned=$cleaned; errors=$cleanupErrors}
  }
  default { throw 'Unknown acceptance operation' }
}
`;

export function buildPowerShellPlan(action, payload, env) {
  const data = { ...payload, action };
  if (action === 'install') data.arguments = installerArguments(payload);
  const safeEnv = isolatedChildEnvironment(env, 'candidate-manual');
  const bootstrap =
    '$m=[IO.MemoryStream]::new([Convert]::FromBase64String($env:OPENH3_ACCEPTANCE_SCRIPT));$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);try { & ([ScriptBlock]::Create($r.ReadToEnd())) } finally { $r.Dispose();$g.Dispose();$m.Dispose() }';
  return {
    file: 'powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      Buffer.from(bootstrap, 'utf16le').toString('base64'),
    ],
    env: {
      ...safeEnv,
      OPENH3_ACCEPTANCE_SCRIPT: gzipSync(POWERSHELL).toString('base64'),
      OPENH3_ACCEPTANCE_PAYLOAD: Buffer.from(JSON.stringify(data), 'utf8').toString('base64'),
    },
  };
}

function isolatedChildEnvironment(env, mode) {
  const result = childEnvironment(env, mode);
  for (const key of Object.keys(result)) {
    if (/^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|OPENH3_BACKEND_BIN|AIONUI_BACKEND_BIN)$/i.test(key))
      delete result[key];
  }
  return result;
}

async function executePlan(plan, { onRecord = () => {}, timeoutMs = 660_000 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(plan.file, plan.args, { env: plan.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let pending = '';
    let stderr = '';
    let result;
    let fault;
    const timeout = setTimeout(() => {
      fault = Error('Acceptance helper timeout');
      proc.kill();
    }, timeoutMs);
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    const line = (text) => {
      if (!text.trim()) return;
      try {
        const value = JSON.parse(text.replace(/^\uFEFF/, ''));
        if (value.kind === 'result') result = value;
        else onRecord(value);
      } catch (error) {
        fault = error;
        proc.kill();
      }
    };
    proc.stdout.on('data', (text) => {
      pending += text;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, end));
        pending = pending.slice(end + 1);
      }
    });
    proc.stderr.on('data', (text) => {
      stderr = (stderr + text).slice(-16_384);
    });
    proc.once('error', (error) => {
      fault = error;
    });
    proc.once('close', (code) => {
      clearTimeout(timeout);
      if (pending.trim()) line(pending);
      if (fault) reject(fault);
      else if (code !== 0 || !result) reject(Error(`Acceptance helper failed (${code}): ${stderr}`));
      else resolve(result);
    });
  });
}

export function createWindowsAdapter(env, deps = {}) {
  assertHostedRunner(env, deps.platform ?? process.platform, deps.arch ?? process.arch);
  // Any explicit dependency seam, even an empty one, is ineligible for real evidence.
  const testOnly = arguments.length > 1;
  const fsOps = deps.fsOps ?? fs;
  const run =
    deps.powershell ?? ((action, data, options) => executePlan(buildPowerShellPlan(action, data, env), options));
  const pause = deps.sleep ?? sleep;
  let root;
  let cdnBlock;
  let cdnAttempted = false;
  let freshProfileChecked = false;
  let controlledLaunchSequence = 0;
  const registry = [];
  const allowed = new Set();
  const installs = new Set();
  const dataDirs = new Set();
  const monitors = new Map();
  const backgrounds = new Set();
  const snapshotObservers = new Set();
  let backgroundSequence = 0;
  const addOwned = (record) => {
    assertUnambiguousWindowsPath(record.executable);
    if (selectOwnedProcesses([record], [record]).length !== 1 || !allowed.has(record.executable.toLowerCase()))
      throw Error('Unproven process identity/executable');
    if (!registry.some((p) => sameProcess(p, record))) registry.push(record);
  };
  const physical = async (value) => {
    const real = await fsOps.realpath(value);
    if (!samePath(value, real)) throw Error('Physical realpath differs from requested owned path');
    return real;
  };
  const checked = async (value, options = {}) => {
    if (!root) throw Error('No verified owned root');
    const requested = assertUnambiguousWindowsPath(value);
    const file = samePath(root, requested) ? root : assertWithinWindows(root, requested);
    await run('path', { path: file, create: !!options.create, missingLeaf: !!options.missingLeaf });
    await physical(options.missingLeaf ? path.win32.dirname(file) : file);
    return file;
  };
  const snapshot = async () => (await run('snapshot', { registry, allowedExecutables: [...allowed] })).processes ?? [];
  const refresh = async () => {
    const processes = await snapshot();
    for (const item of collectOwnedDescendants(processes, registry, [...allowed])) addOwned(item);
    for (const observe of snapshotObservers) observe(processes);
    return processes;
  };
  const ownInstalledExecutables = async (installDir) => {
    // Discover exact physical exe files from this actual installation, not PATH.
    const { executables = [] } = await run('executables', { path: installDir });
    for (const item of executables) {
      const file = assertWithinWindows(installDir, assertUnambiguousWindowsPath(item));
      if (!/\.exe$/i.test(file)) throw Error('Non-executable in installed allowlist');
      await physical(file);
      allowed.add(file.toLowerCase());
    }
  };
  const startBackground = async (action, payload, onRecord = () => {}) => {
    const directory = path.win32.join(root, 'watch-control');
    await adapter.ensureOwnedDirectory(directory);
    const stopFile = path.win32.join(directory, `${action}-${++backgroundSequence}.stop`);
    let readyResolve;
    let readyReject;
    let readySeen = false;
    let complete = false;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const done = run(
      action,
      { ...payload, stopFile },
      {
        onRecord(record) {
          if (record.kind === 'ready') {
            readySeen = true;
            readyResolve(record);
          } else onRecord(record);
        },
      }
    ).then(
      (result) => {
        complete = true;
        if (!readySeen) readyReject(Error(`${action} stopped before subscription/handle readiness`));
        return result;
      },
      (error) => {
        complete = true;
        readyReject(error);
        throw error;
      }
    );
    // Keep a rejected background operation handled until its caller consumes it.
    done.catch(() => {});
    const controller = {
      done,
      async stop() {
        try {
          if (!complete) await adapter.writeFile(stopFile, Buffer.from('stop\n'));
          return await done;
        } finally {
          backgrounds.delete(controller);
        }
      },
    };
    backgrounds.add(controller);
    let timer;
    try {
      await Promise.race([
        ready,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(Error(`${action} readiness timeout`)),
            deps.backgroundReadyTimeoutMs ?? 30_000
          );
        }),
      ]);
    } catch (error) {
      try {
        await controller.stop();
      } catch (stopError) {
        throw new AggregateError([error, stopError], `${action} readiness and cleanup failed`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
    return controller;
  };
  const adapter = {
    testOnly,
    async ensureOwnedRoot(value) {
      if (root) throw Error('Owned root already established');
      const requested = assertWithinWindows(
        assertUnambiguousWindowsPath(env.RUNNER_TEMP),
        assertUnambiguousWindowsPath(value)
      );
      await run('path', { path: requested, create: true, missingLeaf: false });
      await physical(env.RUNNER_TEMP);
      await physical(requested);
      root = requested;
    },
    async ensureOwnedDirectory(value) {
      await checked(value, { create: true });
    },
    async assertFreshProductProfile() {
      if (!root) throw Error('No verified owned root');
      const appData = assertUnambiguousWindowsPath(env.APPDATA);
      await run('path', { path: appData, create: false, missingLeaf: false });
      await physical(appData);
      for (const product of ['OpenH3', 'AionUi']) {
        const profile = path.win32.join(appData, product);
        try {
          await fsOps.lstat(profile);
        } catch (error) {
          if (error.code === 'ENOENT') continue;
          throw error;
        }
        throw Error(`Refusing preexisting product profile: ${profile}`);
      }
      freshProfileChecked = true;
    },
    async readFile(value, encoding) {
      return fsOps.readFile(await checked(value), encoding);
    },
    async writeFile(value, bytes) {
      await checked(path.win32.dirname(value), { create: true });
      const file = await checked(value, { missingLeaf: true });
      await fsOps.writeFile(file, bytes, { flag: 'w' });
      await checked(file);
    },
    async writeJson(value, data) {
      await adapter.writeFile(value, `${JSON.stringify(data, null, 2)}\n`);
    },
    async inspectSignature(value) {
      const result = await run('signature', { path: await checked(value) });
      if (!['Valid', 'NotSigned'].includes(result.status))
        throw Error(`Authenticode signature rejected: ${result.status}`);
      return { status: result.status, subject: result.subject, thumbprint: result.thumbprint };
    },
    async enableCdnIsolation() {
      if (!root || cdnBlock) throw Error('CDN guard needs one established owned root and may only be enabled once');
      const marker = `OPENH3-ACCEPTANCE-${createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16)}`;
      cdnBlock = `\r\n# BEGIN ${marker}\r\n0.0.0.0 static.aionui.com\r\n:: static.aionui.com\r\n# END ${marker}\r\n`;
      cdnAttempted = true;
      return run('cdn-enable', { block: cdnBlock });
    },
    async install({ installerPath, installDir, logPath, session, version }) {
      if (!['3.0.0', '3.0.1'].includes(version)) throw Error('Unsupported installed acceptance version');
      installerPath = await checked(installerPath);
      installDir = await checked(installDir, { create: true });
      await checked(path.win32.dirname(logPath), { create: true });
      await checked(logPath, { missingLeaf: true });
      allowed.add(installerPath.toLowerCase());
      installs.add(installDir);
      const result = await run(
        'install',
        {
          installerPath,
          installDir,
          logPath,
          session,
          version,
          childEnv: isolatedChildEnvironment(env, version === '3.0.0' ? 'official-old' : 'candidate-manual'),
        },
        {
          onRecord(value) {
            if (value.kind === 'started') {
              if (!samePath(value.record?.executable ?? '', installerPath)) throw Error('Wrong started installer');
              addOwned(value.record);
            }
          },
        }
      );
      if (!registry.some((p) => sameProcess(p, result))) throw Error('Installer started identity was not recorded');
      if (result.exitCode !== 0) throw Error(`Installer exited ${result.exitCode}`);
      const events = parseInstallerJsonl(await adapter.readFile(logPath, 'utf8'));
      assertInstallerSuccess(events, { session, version, updated: false, installDir });
      return { ...result, events };
    },
    async launchInstalled({ executablePath, mode, cwd, feedUrl }) {
      if (!['official-old', 'candidate-manual', 'candidate-updater'].includes(mode))
        throw Error('Unsupported installed launch mode');
      executablePath = await checked(executablePath);
      cwd = await checked(cwd);
      const installDir = [...installs].find((directory) => {
        try {
          assertWithinWindows(directory, executablePath);
          return true;
        } catch {
          return false;
        }
      });
      if (!installDir) throw Error('Executable is not in this adapter installation');
      await ownInstalledExecutables(installDir);
      const appEnv = isolatedChildEnvironment(env, mode);
      let nsisTemp;
      let auditPath;
      let auditSession;
      if (mode === 'candidate-updater') {
        const feed = new URL(feedUrl);
        if (feed.protocol !== 'http:' || feed.hostname !== '127.0.0.1' || !feed.port || feed.username || feed.password)
          throw Error('Updater mode requires explicit loopback fixture feed');
        nsisTemp = path.win32.join(root, 'nsis-temp');
        await adapter.ensureOwnedDirectory(nsisTemp);
        appEnv.TEMP = nsisTemp;
        appEnv.TMP = nsisTemp;
        auditSession = randomBytes(12).toString('hex');
        auditPath = path.win32.join(root, 'evidence', 'os', `installed-updater-${auditSession}.jsonl`);
        await checked(path.win32.dirname(auditPath), { create: true });
        await checked(auditPath, { missingLeaf: true });
      }
      // Keep this import inside the guarded runtime operation. No browser download.
      const electron = deps.loadElectron ? await deps.loadElectron() : (await import('playwright'))._electron;
      const ea = await electron.launch({ executablePath, cwd, env: appEnv, args: [], timeout: 60_000 });
      const launchSequence = ++controlledLaunchSequence;
      const fixtureIdentity =
        mode === 'candidate-updater'
          ? await ea.evaluate(installUpdaterFixture, {
              expectedInstalledExe: executablePath,
              feedUrl,
              auditPath,
              auditSession,
            })
          : undefined;
      if (fixtureIdentity && (fixtureIdentity.auditPath !== auditPath || fixtureIdentity.auditSession !== auditSession))
        throw Error('Installed updater audit path/session mismatch');
      // On Windows Playwright's process() may be cmd.exe. Never register it as main.
      const identity = await ea.evaluate(installedIdentity);
      const initial = await snapshot();
      const main = initial.find((p) => Number(p.pid) === identity.pid && samePath(p.executable, executablePath));
      if (!main) throw Error('Actual installed main process not proven by OS snapshot');
      addOwned(main);
      const mediaScript = path.win32.join(
        installDir,
        'resources',
        'app.asar.unpacked',
        'out',
        'main',
        'media-service.js'
      );
      const mediaChildren = initial.filter((p) => isInstalledMediaChild(p, main, mediaScript));
      if (mediaChildren.length) {
        await checked(mediaScript);
        for (const child of mediaChildren) addOwned({ ...child, role: 'media-service' });
      }
      if (
        mode === 'candidate-updater' &&
        initial.some(
          (p) =>
            samePath(p.executable, executablePath) &&
            !sameProcess(p, main) &&
            !mediaChildren.some((child) => sameProcess(p, child)) &&
            !windowsArguments(p.commandLine ?? '').some(
              (arg) => arg === '--type' || arg.startsWith('--type=') || arg.startsWith('--type-process=')
            )
        )
      )
        throw Error('Updater fixture requires an exclusive installed main; additional exact image instance found');
      if (
        !identity.packaged ||
        identity.version !== (mode === 'official-old' ? '3.0.0' : '3.0.1') ||
        !samePath(identity.executable, executablePath)
      )
        throw Error('Wrong real installed identity');
      await checked(identity.appRoot);
      let updaterCache;
      if (mode === 'candidate-updater') {
        const actual = await ea.evaluate(readDownloadedUpdate);
        if (actual.config?.provider !== 'github' || actual.config?.owner !== 'pigq' || actual.config?.repo !== 'OpenH3')
          throw Error('Installed on-disk production feed is not pigq/OpenH3 GitHub');
        const cacheBase = assertUnambiguousWindowsPath(actual.cacheBase);
        if (!samePath(cacheBase, assertUnambiguousWindowsPath(env.LOCALAPPDATA)))
          throw Error('Updater cache must use actual fresh hosted LOCALAPPDATA');
        await run('path', { path: cacheBase, create: false, missingLeaf: false });
        await physical(cacheBase);
        const cacheDir = assertWithinWindows(cacheBase, assertUnambiguousWindowsPath(actual.cacheDir));
        const pendingDir = assertWithinWindows(cacheDir, assertUnambiguousWindowsPath(actual.pendingDir));
        await run('path', { path: cacheDir, create: true, missingLeaf: false });
        await physical(cacheDir);
        try {
          await fsOps.lstat(pendingDir);
          throw Error('Refusing preexisting pending updater cache');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (actual.file !== null) throw Error('Updater fixture must begin without an existing downloaded installer');
        updaterCache = { ...actual, cacheBase, cacheDir };
      }
      let stopped = false;
      let monitorError;
      let inFlight = Promise.resolve();
      let busy = false;
      const monitor = setInterval(() => {
        if (stopped || busy) return;
        busy = true;
        inFlight = refresh()
          .catch((error) => {
            monitorError = error;
          })
          .finally(() => {
            busy = false;
          });
      }, 750);
      monitor.unref?.();
      const stopMonitor = async () => {
        stopped = true;
        clearInterval(monitor);
        await inFlight;
      };
      monitors.set(monitor, stopMonitor);
      await ea.firstWindow({ timeout: 60_000 });
      const rendererDeadline = Date.now() + 60_000;
      let page;
      while (!page) {
        for (const candidate of ea.windows()) {
          try {
            if (
              await candidate.evaluate(
                () =>
                  Number.isInteger(window.__backendPort) &&
                  window.__backendPort > 0 &&
                  !!document.querySelector('#root')?.childElementCount
              )
            ) {
              page = candidate;
              break;
            }
          } catch {
            /* transient navigation/closed splash; continue bounded scan */
          }
        }
        if (!page) {
          if (Date.now() >= rendererDeadline) throw Error('No real installed renderer with nonempty root/backend port');
          await pause(100);
        }
      }
      const windowHandle = await ea.browserWindow(page);
      let visible;
      try {
        do {
          visible = await windowHandle.evaluate((window) => !window.isDestroyed() && window.isVisible());
          if (visible !== true) {
            if (Date.now() >= rendererDeadline) throw Error('Installed main BrowserWindow is not visible');
            await pause(100);
          }
        } while (visible !== true);
      } finally {
        await windowHandle.dispose();
      }
      const request = installedBackendRequest(page);
      const systemInfo = await request('GET', '/api/system/info');
      const port = await page.evaluate(() => window.__backendPort);
      const health = await page.evaluate(async (port) => {
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid actual backend port');
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(10_000) });
        const value = await response.json();
        if (!response.ok || value?.status !== 'ok') throw Error('Actual local backend health failed');
        return value;
      }, port);
      if (health?.status !== 'ok') throw Error('Actual local backend health failed');
      const processes = await refresh();
      const listeners = (await run('listeners', { port })).pids ?? [];
      const backendCandidates = selectOwnedProcesses(processes, registry).filter(
        (p) => listeners.some((pid) => Number(pid) === Number(p.pid)) && Number(p.pid) !== Number(main.pid)
      );
      if (backendCandidates.length !== 1)
        throw Error('Local backend listener is not exactly one proven installed descendant');
      const backend = backendCandidates[0];
      const backendDataDir = backendDataDirectory(backend.commandLine);
      await run('path', { path: backendDataDir, create: false, missingLeaf: false });
      await physical(backendDataDir);
      dataDirs.add(backendDataDir);
      const assertFixture = () => {
        if (!fixtureIdentity) throw Error('This launch has no controlled installed updater fixture');
      };
      const exitWatcher = await startBackground('exit-watch', { registry: [main, backend] });
      let normalExitEvidence;
      const waitNormallyExited = async () => {
        if (monitorError) throw monitorError;
        const deadline = Date.now() + 60_000;
        for (;;) {
          const current = await refresh();
          if (
            selectOwnedProcesses(
              current,
              registeredLaunchTree(
                registry,
                main,
                [...allowed].filter((file) => {
                  try {
                    assertWithinWindows(installDir, file);
                    return true;
                  } catch {
                    return false;
                  }
                })
              )
            ).length === 0
          )
            break;
          if (Date.now() >= deadline)
            throw Error('Normal exit did not stop all registered main/backend descendants within 60 seconds');
          await pause(200);
        }
        await stopMonitor();
        monitors.delete(monitor);
        if (monitorError) throw monitorError;
        const exitEvidence = await exitWatcher.done;
        if (
          exitEvidence.completed !== true ||
          !exitEvidence.exits?.some((exit) => sameProcess(exit, main) && exit.exitCode === 0) ||
          !exitEvidence.exits?.some((exit) => sameProcess(exit, backend) && Number.isInteger(exit.exitCode))
        )
          throw Error(
            'Normal exit requires retained main handle exit code zero and actual backend handle exit evidence'
          );
        normalExitEvidence = {
          normalExit: true,
          method: 'real-app-quit-and-product-backend-stop',
          harnessForcedTermination: false,
          backendStopSemantics:
            'Product stop may use taskkill on Windows; actual backend exit code is recorded without requiring zero',
          main,
          backend,
          exits: exitEvidence.exits,
        };
        return normalExitEvidence;
      };
      let observationStarted = false;
      let preparedNativeHandoff;
      const startUpdateObservation = async ({ expectedInstallerSha256 }) => {
        assertFixture();
        if (observationStarted) throw Error('Only one update observation is allowed per launch');
        if (!/^[a-f0-9]{64}$/.test(expectedInstallerSha256 ?? ''))
          throw Error('Expected exact candidate SHA256 digest');
        const actual = await ea.evaluate(readDownloadedUpdate);
        if (
          actual.config?.provider !== 'github' ||
          actual.config?.owner !== 'pigq' ||
          actual.config?.repo !== 'OpenH3' ||
          !samePath(actual.pendingDir, updaterCache.pendingDir) ||
          actual.file !== null
        )
          throw Error('Observation must begin before download with unchanged on-disk production feed/cache');
        observationStarted = true;
        let stopped = false;
        let handoffWatcher;
        let handoffFault;
        let restartExitWatcher;
        let restartProof;
        const evidenceFile = path.win32.join(
          root,
          'evidence',
          'os',
          `updater-observation-${++backgroundSequence}.json`
        );
        const evidence = {
          complete: false,
          mechanism: 'durable-installed-singleton-doInstall-audit-plus-OS-observations',
          scope: 'this-installed-updater-doInstall-only',
          globalOSProcessAbsenceProven: false,
          started: new Date().toISOString(),
          evidenceFile,
          expectedInstallerSha256,
          productionFeed: actual.config,
          cache: updaterCache,
          observedProcesses: [],
          snapshots: [],
          installers: [],
          osEvents: [],
          restartCandidates: [],
          limitations: [
            'No claim of global operating-system process absence; snapshots can miss unrelated short-lived processes.',
            'Automatic restart attribution requires this fresh VM, exact installed image/SID, new --updated identity and a successful native NSIS session; parent chain is supplemental.',
          ],
        };
        const observe = (processes) => {
          if (stopped) return;
          const owned = selectOwnedProcesses(processes, registry);
          evidence.snapshots.push({ at: new Date().toISOString(), ownedPids: owned.map((p) => p.pid) });
          for (const process of owned) {
            if (!evidence.observedProcesses.some((p) => sameProcess(p, process)))
              evidence.observedProcesses.push(process);
            if (
              evidence.prepared &&
              samePath(process.executable, evidence.prepared.file) &&
              !evidence.installers.some((p) => sameProcess(p, process))
            )
              evidence.installers.push(process);
          }
          if (evidence.snapshots.length > 2048) {
            evidence.snapshots.shift();
            evidence.snapshotsTruncated = true;
          }
        };
        snapshotObservers.add(observe);
        await refresh();
        const assertActive = () => {
          if (stopped) throw Error('Update observation already stopped');
        };
        const notCovered = (message) => {
          const error = Object.assign(Error(message), { code: 'NOT_COVERED', evidence });
          throw error;
        };
        const waitFor = async (predicate, message, timeoutMs = 60_000) => {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            if (handoffFault) throw handoffFault;
            const result = await predicate();
            if (handoffFault) throw handoffFault;
            if (result) return result;
            if (Date.now() >= deadline) return notCovered(message);
            await pause(100);
          }
        };
        const readAudit = async () => {
          const records = parseInstallerJsonl(await adapter.readFile(auditPath, 'utf8'));
          if (
            !records.length ||
            records[0].kind !== 'fixture-installed' ||
            records[0].delegatedNativeMethod !== 'NsisUpdater.doInstall'
          )
            throw Error('Missing native install-boundary audit baseline');
          for (let i = 0; i < records.length; i++) {
            const record = records[i];
            if (
              record.schemaVersion !== 1 ||
              record.session !== auditSession ||
              record.sequence !== i ||
              Number(record.pid) !== Number(main.pid) ||
              !samePath(record.executable, executablePath) ||
              !Number.isFinite(Date.parse(record.at))
            )
              throw Error('Install audit identity/sequence mismatch');
          }
          if (!normalExitEvidence) {
            const live = await ea.evaluate(snapshotInstallAudit);
            if (
              live.wrapperIntact !== true ||
              live.path !== auditPath ||
              live.session !== auditSession ||
              JSON.stringify(live.records) !== JSON.stringify(records)
            )
              throw Error('Live installed updater audit differs from durable records');
          } else {
            const terminal = records.at(-1);
            const attempts = records.filter((r) => r.kind === 'do-install-enter').length;
            if (
              terminal?.kind !== 'fixture-process-exit' ||
              terminal.exitCode !== 0 ||
              terminal.auditPrefixHealthy !== true ||
              terminal.wrapperIntact !== true ||
              terminal.installAttempts !== attempts ||
              records.filter((r) => r.kind === 'fixture-process-exit').length !== 1
            )
              throw Error(
                'Normally exited updater requires final healthy fixture-process-exit terminal with exact attempt count'
              );
          }
          const audit = { path: auditPath, session: auditSession, wrapperIntact: true, scope: evidence.scope, records };
          evidence.audit = audit;
          return audit;
        };
        await readAudit();
        return {
          evidence: () => evidence,
          async prepareHandoff({ expectedInstallerSha256: requestedHash }) {
            assertActive();
            if (requestedHash !== expectedInstallerSha256)
              throw Error('Handoff digest differs from observation candidate hash');
            if (evidence.prepared) throw Error('Native handoff already prepared');
            if (
              !freshProfileChecked ||
              launchSequence !== 1 ||
              controlledLaunchSequence !== launchSequence ||
              !main.sid ||
              main.sid !== backend.sid
            )
              return notCovered(
                'Native handoff/restart requires a checked fresh hosted profile, first/exclusive controlled launch and matching native SID'
              );
            const downloaded = await ea.evaluate(readDownloadedUpdate);
            if (
              downloaded.config?.provider !== 'github' ||
              downloaded.config?.owner !== 'pigq' ||
              downloaded.config?.repo !== 'OpenH3' ||
              !samePath(downloaded.pendingDir, updaterCache.pendingDir) ||
              !samePath(downloaded.cacheDir, updaterCache.cacheDir)
            )
              throw Error('Actual downloaded cache/production feed changed');
            if (
              downloaded.version !== '3.0.1' ||
              downloaded.packageFile !== null ||
              downloaded.isAdminRightsRequired === true
            )
              throw Error('Unexpected actual downloaded package/version/admin identity');
            const file = assertWithinWindows(updaterCache.pendingDir, assertUnambiguousWindowsPath(downloaded.file));
            if (!/\.exe$/i.test(file)) throw Error('Actual downloaded update is not an executable');
            await run('path', { path: file, create: false, missingLeaf: false });
            await physical(file);
            const bytes = await fsOps.readFile(file);
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const sha512 = createHash('sha512').update(bytes).digest('base64');
            if (!bytes.length || sha256 !== expectedInstallerSha256 || sha512 !== downloaded.sha512)
              throw Error('Actual downloaded installer digest mismatch');
            allowed.add(file.toLowerCase());
            const uninstallerPath = await checked(path.win32.join(installDir, 'Uninstall OpenH3.exe'));
            const uninstallerSha256 = createHash('sha256')
              .update(await fsOps.readFile(uninstallerPath))
              .digest('hex');
            evidence.prepared = {
              file,
              sha256,
              sha512,
              uninstallerPath,
              uninstallerSha256,
              version: downloaded.version,
              cacheDir: downloaded.cacheDir,
              pendingDir: downloaded.pendingDir,
              productionFeed: downloaded.config,
            };
            await checked(nsisTemp);
            const existingLogs = (await fsOps.readdir(nsisTemp)).filter((name) =>
              /^aionui-installer-.*\.jsonl$/i.test(name)
            );
            if (existingLogs.length) throw Error('Refusing preexisting native-updater installer logs in isolated TEMP');
            evidence.handoffStarted = new Date().toISOString();
            handoffWatcher = await startBackground(
              'handoff-watch',
              {
                registry: [main, backend],
                mainPid: main.pid,
                executablePath,
                installerPath: file,
                sha256,
                uninstallerSha256,
                nsisTemp,
                sid: main.sid,
                started: evidence.handoffStarted,
              },
              (record) => {
                evidence.osEvents.push({ received: new Date().toISOString(), ...record });
                try {
                  if (record.kind === 'observation-gap')
                    throw Error(`Native handoff observation gap: ${record.error ?? 'unknown'}`);
                  if (record.kind === 'observed') {
                    const process = record.record;
                    if (record.role === 'installer') {
                      if (
                        !samePath(process.executable, file) ||
                        process.sha256 !== sha256 ||
                        Number(process.parentPid) !== Number(main.pid)
                      )
                        throw Error('Observed updater installer differs from bound cache/hash/parent identity');
                      const args = windowsArguments(process.commandLine);
                      if (
                        !args.includes('--updated') ||
                        !args.includes('/S') ||
                        !args.includes('--force-run') ||
                        args.some((arg) => /^(?:--admin|\/NCRC)$/i.test(arg))
                      )
                        throw Error(
                          'Observed native installer command argv lacks real silent force-run update arguments'
                        );
                      if (!evidence.installers.some((p) => sameProcess(p, process))) evidence.installers.push(process);
                    } else if (record.role === 'nsis-installer') {
                      assertWithinWindows(nsisTemp, assertUnambiguousWindowsPath(process.executable));
                      if (
                        !['old-uninstaller.exe', 'aionui-fixed-uninstaller.exe'].includes(
                          path.win32.basename(process.executable).toLowerCase()
                        ) ||
                        process.sha256 !== uninstallerSha256 ||
                        !evidence.osEvents.some(
                          (e) =>
                            e.kind === 'observed' &&
                            ['installer', 'nsis-installer'].includes(e.role) &&
                            Number(e.record?.pid) === Number(process.parentPid) &&
                            Date.parse(e.record.created) <= Date.parse(process.created)
                        )
                      )
                        throw Error('Unknown native installer helper image/hash/parent identity');
                      allowed.add(process.executable.toLowerCase());
                    } else throw Error('Unknown owned native handoff process role');
                    if (process.sid !== main.sid || Date.parse(process.created) < Date.parse(evidence.handoffStarted))
                      throw Error('Observed native installer changed owner SID or predates handoff');
                    addOwned(process);
                  } else if (record.kind === 'restart-candidate') evidence.restartCandidates.push(record.record);
                } catch (error) {
                  handoffFault ??= Object.assign(error, { code: 'NOT_COVERED' });
                }
              }
            );
            handoffWatcher.done.then(
              () => {
                if (!stopped)
                  handoffFault ??= Object.assign(Error('Native handoff observer ended before an explicit stop'), {
                    code: 'NOT_COVERED',
                  });
              },
              (error) => {
                handoffFault ??= Object.assign(error, { code: 'NOT_COVERED' });
              }
            );
            preparedNativeHandoff = evidence.prepared;
            return evidence.prepared;
          },
          async proveNoInstaller({ durationMs }) {
            assertActive();
            if (!Number.isFinite(durationMs) || durationMs <= 0) throw Error('Expected positive observation duration');
            const started = new Date().toISOString();
            await readAudit();
            await pause(durationMs);
            await refresh();
            const audit = await readAudit();
            if (
              audit.records.some(
                (r) => r.kind === 'do-install-enter' || r.kind === 'do-install-return' || r.kind === 'do-install-throw'
              )
            )
              throw Error('Unexpected native updater install attempt');
            const result = {
              complete: true,
              scope: evidence.scope,
              globalOSProcessAbsenceProven: false,
              started,
              ended: new Date().toISOString(),
              durationMs,
              installers: [],
              audit,
            };
            evidence.noInstallWindows ??= [];
            evidence.noInstallWindows.push(result);
            evidence.complete = true;
            return result;
          },
          async waitForInstaller() {
            assertActive();
            if (!handoffWatcher)
              return notCovered('Native handoff was not prepared; no installer will be started by the observer');
            const exited = await waitFor(
              () => evidence.osEvents.find((e) => e.kind === 'process-exit' && e.role === 'installer'),
              'Actual bound native installer PID/handle exit was not observed',
              600_000
            );
            const actual = evidence.installers.filter((p) => sameProcess(p, exited.record));
            if (actual.length !== 1 || exited.record.exitCode !== 0)
              throw Error('Native installer identity/real exit code did not succeed');
            await waitNormallyExited();
            const audit = await readAudit();
            const attempts = audit.records.filter((r) => r.kind === 'do-install-enter');
            if (
              attempts.length !== 1 ||
              !samePath(attempts[0].installerPath ?? '', evidence.prepared.file) ||
              attempts[0].isSilent !== true ||
              attempts[0].isForceRunAfter !== true ||
              attempts[0].isAdminRightsRequired === true ||
              audit.records.some((r) => r.kind === 'do-install-throw') ||
              !audit.records.some((r) => r.kind === 'do-install-return' && r.result === true)
            )
              throw Error('Durable audit did not delegate exactly one expected native silent force-run installer');
            const names = (await fsOps.readdir(nsisTemp)).filter((name) =>
              /^aionui-installer-3\.0\.1-\d{8}-log\.jsonl$/.test(name)
            );
            if (names.length !== 1) throw Error('Expected one real default NSIS updater log in isolated TEMP');
            const logPath = path.win32.join(nsisTemp, names[0]);
            const logBytes = await adapter.readFile(logPath);
            const events = parseInstallerJsonl(logBytes.toString('utf8'));
            const sessions = [...new Set(events.map((e) => e.session))];
            if (sessions.length !== 1 || !/^[a-f0-9]{12}$/.test(sessions[0]))
              throw Error('Native NSIS log session is not unique');
            assertInstallerSuccess(events, { session: sessions[0], version: '3.0.1', updated: true, installDir });
            if (
              !events.some(
                (e) =>
                  e.event === 'session-end' &&
                  Number.isFinite(Date.parse(e.ts)) &&
                  Date.parse(e.ts) >= Date.parse(evidence.handoffStarted)
              )
            )
              throw Error('Native NSIS success predates this handoff');
            const archivedLogPath = path.win32.join(root, 'evidence', 'os', `native-updater-${sessions[0]}.jsonl`);
            await adapter.writeFile(archivedLogPath, logBytes);
            if (handoffFault) throw handoffFault;
            evidence.installerHandoff = {
              complete: true,
              scope: 'this-audited-native-handoff-process-and-NSIS-session',
              globalOSProcessAbsenceProven: false,
              ...exited.record,
              session: sessions[0],
              events,
              audit,
              logPath,
              archivedLogPath,
            };
            return evidence.installerHandoff;
          },
          async waitForRestart() {
            assertActive();
            if (!evidence.installerHandoff)
              return notCovered('Automatic restart cannot be attributed before real native installer/session success');
            if (!freshProfileChecked || controlledLaunchSequence !== launchSequence)
              return notCovered(
                'Another controlled launch invalidated exclusive fresh-VM automatic restart attribution'
              );
            const restarted = await waitFor(async () => {
              const current = await refresh();
              const candidates = current.filter(
                (p) =>
                  samePath(p.executable, executablePath) &&
                  !sameProcess(p, main) &&
                  p.sid === main.sid &&
                  Date.parse(p.created) >= Date.parse(evidence.handoffStarted) &&
                  windowsArguments(p.commandLine).includes('--updated') &&
                  !windowsArguments(p.commandLine).some((arg) => arg === '--type' || arg.startsWith('--type='))
              );
              if (candidates.length > 1)
                throw Error('Automatic restart exact image/SID/--updated identity is not unique');
              return candidates[0];
            }, 'No unique fresh-VM native --updated main was observed after successful NSIS handoff');
            await checked(restarted.executable);
            addOwned(restarted);
            const ready = await waitFor(async () => {
              const window = await run('window', { record: restarted });
              if (window.visible !== true || !window.hwnd || !sameProcess(window.record, restarted)) return false;
              const current = await refresh();
              const children = registeredLaunchTree(current, restarted, [...allowed]);
              for (const child of children) {
                if (child.sid === restarted.sid) addOwned(child);
              }
              const backends = children.filter(
                (p) =>
                  p.pid !== restarted.pid &&
                  p.sid === restarted.sid &&
                  (() => {
                    try {
                      return samePath(backendDataDirectory(p.commandLine), backendDataDir);
                    } catch {
                      return false;
                    }
                  })()
              );
              if (backends.length > 1) throw Error('Automatic restart backend is not unique');
              if (!backends.length) return false;
              const newBackend = backends[0];
              const port = backendPort(newBackend.commandLine);
              if (
                !((await run('listeners', { port })).pids ?? []).some((pid) => Number(pid) === Number(newBackend.pid))
              )
                return false;
              const fetcher = deps.fetch ?? fetch;
              const get = async (route) => {
                const response = await fetcher(`http://127.0.0.1:${port}${route}`, {
                  signal: AbortSignal.timeout(10_000),
                  redirect: 'error',
                });
                const value = await response.json();
                if (!response.ok) throw Error('Restart backend HTTP failure');
                return value;
              };
              try {
                const health = await get('/health');
                if (health?.status !== 'ok') return false;
                const user = await get('/api/system/current-user');
                const settings = await get('/api/settings/client?keys=system.closeToTray');
                if (
                  user.success !== true ||
                  user.data?.id !== 'system_default_user' ||
                  settings.success !== true ||
                  settings.data?.['system.closeToTray'] !== false
                )
                  throw Error('Restart is not the normal local backend with closeToTray=false');
                return {
                  main: restarted,
                  backend: newBackend,
                  backendDataDir,
                  port,
                  health,
                  hwnd: window.hwnd,
                  settings: settings.data,
                };
              } catch (error) {
                if (error.message.includes('normal local backend')) throw error;
                return false;
              }
            }, 'Automatic restart visible HWND and actual descendant backend health were not ready');
            restartExitWatcher = await startBackground('exit-watch', { registry: [restarted, ready.backend] });
            restartProof = {
              observedAutomaticRestart: true,
              attribution: 'fresh-VM-exclusive-install-native-audit-NSIS-session-new-updated-identity',
              parentChainSupplemental: evidence.osEvents.some(
                (e) =>
                  e.kind === 'restart-candidate' && e.directOwnedParent === true && sameProcess(e.record, restarted)
              ),
              globalOSProcessAbsenceProven: false,
              ...ready,
            };
            evidence.automaticRestart = restartProof;
            return restartProof;
          },
          async quitRestartNormally() {
            assertActive();
            if (!restartProof || !restartExitWatcher)
              return notCovered('No proven automatic-restart window/main/backend handles; no close or kill was sent');
            const requested = await run('close-window', { record: restartProof.main, hwnd: restartProof.hwnd });
            if (requested.requested !== true) throw Error('Owned restart did not accept normal WM_CLOSE');
            const exitResult = await Promise.race([
              restartExitWatcher.done,
              new Promise((_, reject) => {
                const timer = setTimeout(
                  () => reject(Error('Restart normal window close did not exit main/backend within 60 seconds')),
                  60_000
                );
                timer.unref?.();
                restartExitWatcher.done.finally(() => clearTimeout(timer)).catch(() => {});
              }),
            ]);
            if (
              exitResult.completed !== true ||
              !exitResult.exits?.some((e) => sameProcess(e, restartProof.main) && e.exitCode === 0) ||
              !exitResult.exits?.some((e) => sameProcess(e, restartProof.backend) && Number.isInteger(e.exitCode))
            )
              throw Error(
                'Restart normal exit requires retained main exit code zero and actual backend handle exit evidence'
              );
            await waitFor(
              async () =>
                selectOwnedProcesses(await refresh(), registeredLaunchTree(registry, restartProof.main, [...allowed]))
                  .length === 0,
              'Restart normal close left owned descendants'
            );
            evidence.restartNormalExit = {
              normalExit: true,
              method: 'verified-HWND-CloseMainWindow-WM_CLOSE-and-product-backend-stop',
              harnessForcedTermination: false,
              main: restartProof.main,
              backend: restartProof.backend,
              exits: exitResult.exits,
            };
            evidence.complete = true;
            return evidence.restartNormalExit;
          },
          async stop() {
            const errors = [];
            try {
              if (!stopped) {
                await inFlight;
                await refresh();
              }
            } catch (error) {
              errors.push(error);
            }
            stopped = true;
            snapshotObservers.delete(observe);
            evidence.stopped = new Date().toISOString();
            for (const watcher of [handoffWatcher, restartExitWatcher]) {
              try {
                await watcher?.stop();
              } catch (error) {
                errors.push(error);
              }
            }
            if (handoffFault) errors.push(handoffFault);
            if (errors.length) {
              evidence.complete = false;
              evidence.cleanupErrors = errors.map((e) => e.message);
            }
            await adapter.writeJson(evidenceFile, evidence);
            if (errors.length) throw new AggregateError(errors, 'Native observation cleanup failed');
            return evidence;
          },
        };
      };
      return {
        identity: { ...identity, created: main.created, backend },
        request,
        page,
        backendDataDir,
        systemInfo,
        health,
        fixtureIdentity,
        updaterCache,
        evaluateMain: (callback, argument) => ea.evaluate(callback, argument),
        nativeCheck() {
          assertFixture();
          return ea.evaluate(nativeFixtureCheck);
        },
        updaterEvents() {
          assertFixture();
          return ea.evaluate(snapshotUpdaterEvents);
        },
        invokeUpdate(key, data, timeoutMs) {
          assertFixture();
          if (!key.startsWith('auto-update.')) throw Error('Not an updater IPC provider');
          return invokeProvider(page, key, data, timeoutMs);
        },
        async exerciseSynchronousHandoffRejection({ expectedInstallerSha256 }) {
          assertFixture();
          if (!preparedNativeHandoff || expectedInstallerSha256 !== preparedNativeHandoff.sha256)
            throw Error('Prepare exact native handoff/retained exit handles before testing rejection');
          const suspended = await ea.evaluate(suspendDownloadedUpdate);
          let renderer;
          let native;
          let alive;
          let restored;
          try {
            if (
              !samePath(suspended.installerPath, preparedNativeHandoff.file) ||
              suspended.sha512 !== preparedNativeHandoff.sha512
            )
              throw Error('Suspended helper differs from prepared actual download identity');
            renderer = await invokeInstallAndObserveError(page);
            // The former unconditional force-exit timer fired after one second.
            // Do not require the backend: normal pre-install cleanup stopped it.
            await pause(1_500);
            native = await ea.evaluate(inspectSynchronousHandoffRejection);
            alive = selectOwnedProcesses(await refresh(), [main]).find(
              (p) => p.sid === main.sid && p.ticks === main.ticks
            );
            if (!alive || Number(native.pid) !== Number(main.pid) || !samePath(native.executable, executablePath))
              throw Error('Original installed main identity did not remain alive after rejected handoff');
          } finally {
            // Restore only the exact saved native helper; never download again,
            // replace native methods, or fabricate a completion/error event.
            restored = await ea.evaluate(restoreDownloadedUpdate);
          }
          const actual = await ea.evaluate(readDownloadedUpdate);
          if (
            restored.restored !== true ||
            restored.version !== '3.0.1' ||
            !samePath(restored.file, preparedNativeHandoff.file) ||
            restored.sha512 !== preparedNativeHandoff.sha512 ||
            !samePath(actual.file ?? '', preparedNativeHandoff.file) ||
            !samePath(actual.pendingDir, updaterCache.pendingDir) ||
            !samePath(actual.cacheDir, updaterCache.cacheDir) ||
            actual.config?.provider !== 'github' ||
            actual.config?.owner !== 'pigq' ||
            actual.config?.repo !== 'OpenH3' ||
            actual.version !== '3.0.1' ||
            actual.sha512 !== preparedNativeHandoff.sha512 ||
            actual.packageFile !== null ||
            actual.isAdminRightsRequired === true
          )
            throw Error('Restored actual download/cache/production feed identity differs');
          await run('path', { path: actual.file, create: false, missingLeaf: false });
          await physical(actual.file);
          const bytes = await fsOps.readFile(actual.file);
          const sha256 = createHash('sha256').update(bytes).digest('hex');
          const sha512 = createHash('sha512').update(bytes).digest('base64');
          if (sha256 !== expectedInstallerSha256 || sha512 !== actual.sha512)
            throw Error('Restored actual cache installer digest changed before retry');
          return {
            scope: 'original-BaseUpdater-synchronous-missing-download-state',
            suspended,
            renderer,
            native,
            sameMainAlive: true,
            main: alive,
            restored: { ...restored, sha256, sha512 },
            backendAvailabilityProven: false,
            asynchronousOSSpawnFailureTested: false,
          };
        },
        waitNormallyExited,
        startUpdateObservation,
        async quitNormally() {
          if (monitorError) throw monitorError;
          await refresh();
          await ea.evaluate(ordinaryQuit);
          // Do not ea.close(): that can force-kill and would fabricate a normal quit.
          return waitNormallyExited();
        },
      };
    },
    async sqliteQuickCheck(dbPath) {
      dbPath = assertUnambiguousWindowsPath(dbPath);
      if (
        ![...dataDirs].some((directory) => {
          try {
            assertWithinWindows(directory, dbPath);
            return true;
          } catch {
            return false;
          }
        })
      )
        throw Error('DB outside actual recorded backend data directory');
      await run('path', { path: dbPath, create: false, missingLeaf: false });
      await physical(dbPath);
      const script =
        'import json,pathlib,sqlite3,sys\np=pathlib.Path(sys.argv[1]); assert p.is_file()\nc=sqlite3.connect(p.as_uri()+"?mode=ro",uri=True)\ntry:\n r=c.execute("PRAGMA quick_check").fetchall(); assert r==[("ok",)],r; print(json.dumps({"quick_check":"ok","path":str(p)}))\nfinally:\n c.close()\n';
      const plan = {
        file: 'python',
        args: ['-I', '-c', script, dbPath],
        env: childEnvironment(env, 'candidate-manual'),
      };
      if (deps.runPython) return deps.runPython(plan);
      return new Promise((resolve, reject) => {
        const child = spawn(plan.file, plan.args, {
          env: plan.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(Error('Read-only SQLite quick_check timed out'));
        }, 30_000);
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(Error(`Read-only SQLite quick_check failed: ${stderr}`));
          else {
            try {
              resolve(JSON.parse(stdout));
            } catch (error) {
              reject(error);
            }
          }
        });
      });
    },
    async cleanup() {
      const errors = [];
      let cleaned = [];
      try {
        for (const stop of monitors.values()) {
          try {
            await stop();
          } catch (error) {
            errors.push(error);
          }
        }
        monitors.clear();
        // stop() mutates this set, so iterate its stable snapshot.
        // eslint-disable-next-line unicorn/no-useless-spread
        for (const watch of [...backgrounds]) {
          try {
            await watch.stop();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          await refresh();
        } catch (error) {
          errors.push(error);
        }
        try {
          const result = await run('cleanup', {
            registry: [...registry].reverse(),
            allowedExecutables: [...allowed],
          });
          ({ cleaned = [] } = result);
          for (const failure of result.errors ?? [])
            errors.push(Error(`Owned cleanup failed for PID ${failure.pid}: ${failure.error}`));
        } catch (error) {
          errors.push(error);
        }
      } finally {
        if (cdnAttempted) {
          try {
            await run('cdn-disable', { block: cdnBlock });
            cdnAttempted = false;
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'One or more owned cleanup operations failed');
      return cleaned;
    },
  };
  return adapter;
}
