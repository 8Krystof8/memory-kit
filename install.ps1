# memory-kit installer for Windows (Windows PowerShell 5.1 and PowerShell 7): a private memory in
# one command.
#
#   irm https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.ps1 | iex
#
# irm | iex cannot pass parameters. With parameters (or set the environment variables below first):
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.ps1))) -Yes -Mode local -Lang en -Sectors core,work
#
# It checks git and Node.js 22.5 or newer (it never installs them: it prints the winget commands),
# then creates the memory folder (default $HOME\memory). With the GitHub CLI logged in it offers a
# new PRIVATE repository made from the template. Otherwise it downloads the kit without its history
# and starts a fresh git repository with no remote, so a note can never be pushed to the public kit
# repository. Then it runs the setup (node system\init.mjs). A folder that already holds a memory
# is left alone: the installer offers doctor and upgrade instead.
#
# Parameters (environment variable in brackets):
#   -Dir <path>          the memory folder (MEMORY_KIT_DIR; default $HOME\memory)
#   -Yes                 ask nothing (MEMORY_KIT_YES=1); the setup then needs the three answers
#   -NoGh                never use the GitHub CLI (MEMORY_KIT_NO_GH=1)
#   -Source <url|dir>    where the kit comes from (MEMORY_KIT_SOURCE; default the public kit
#                        repository); a folder is copied as it is, or cloned at -Ref
#   -Ref <tag|branch>    the kit version (MEMORY_KIT_REF; default the newest v* tag, else the
#                        default branch)
#   -Mode, -Lang, -Sectors   setup answers, passed to init (MEMORY_KIT_MODE, MEMORY_KIT_LANG,
#                        MEMORY_KIT_SECTORS)
# NO_COLOR turns colors off. Exit codes: 0 done, 1 a step failed, 2 a usage error or a missing
# prerequisite, 3 refused (the folder is in the way, or an elevated shell), 130 cancelled. Under
# irm | iex the window stays open and the code is left in $LASTEXITCODE.
#
# Very old Windows (.NET older than 4.7) may need TLS 1.2 for the download itself:
#   [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072; irm https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.ps1 | iex
#
# Written for Windows PowerShell 5.1 too: pure ASCII (5.1 reads a file without a BOM in the ANSI
# code page), no && or ||, no ternary or ??, colors only through [char]27 on a VT-capable host.
# Everything runs inside & { }, so no function or preference is left behind in the session.

param(
  [string]$Dir = '',
  [switch]$Yes,
  [switch]$NoGh,
  [string]$Source = '',
  [string]$Ref = '',
  [string]$Mode = '',
  [string]$Lang = '',
  [string[]]$Sectors = @(),
  [switch]$Help
)

& {
  param($P, [bool]$FromFile)

  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $PSDefaultParameterValues = @{ 'Invoke-WebRequest:UseBasicParsing' = $true }

  $KitUrlDefault = 'https://github.com/8Krystof8/memory-kit.git'
  $KitTemplate = '8Krystof8/memory-kit'
  $NodeMinMajor = 22
  $NodeMinMinor = 5
  $NodeFastMinor = 13
  # Shared state lives in two hashtables: functions change their entries, and nothing is created
  # in the script scope (under irm | iex that would be the user's session).
  $st = @{ code = 0; staging = ''; useGh = $false; ghUser = ''; ghName = ''; ghReason = ''; ref = ''; interactive = $false; node = ''; git = ''; gh = '' }
  $opt = @{}
  $onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT

  # -------------------------------------------------------------------------------------------
  # Output: two-space margin, one accent color, ASCII glyphs unless the terminal shows Unicode.

  $color = $false
  try { $color = [bool]$Host.UI.SupportsVirtualTerminal } catch { $color = $false }
  try { if ([Console]::IsOutputRedirected) { $color = $false } } catch { }
  if ($env:NO_COLOR -or $env:TERM -eq 'dumb') { $color = $false }
  if ($env:FORCE_COLOR -and @('0', 'false') -notcontains $env:FORCE_COLOR) { $color = $true }

  $unicode = $false
  if ($env:WT_SESSION -or $env:TERM_PROGRAM -eq 'vscode') { $unicode = $true }
  try { if ([Console]::OutputEncoding.CodePage -eq 65001) { $unicode = $true } } catch { }
  try { if ($onWindows -and [Console]::IsOutputRedirected) { $unicode = $false } } catch { }
  if ($unicode) {
    $gOk = [string][char]0x2713
    $gErr = [string][char]0x2717
    $gDot = [string][char]0x00B7
    $gRule = [string][char]0x2500
  } else {
    $gOk = '+'
    $gErr = 'x'
    $gDot = '-'
    $gRule = '-'
  }
  $esc = [string][char]27

  function Paint([string]$Code, [string]$Text) {
    if (-not $color) { return $Text }
    return $esc + '[' + $Code + 'm' + $Text + $esc + '[0m'
  }
  function Say([string]$Text) { Write-Host $Text }
  function Write-Ok([string]$Text) { Write-Host ('  ' + (Paint '32' $gOk) + ' ' + $Text) }
  function Write-Note([string]$Text) { Write-Host ('  ' + (Paint '90' $gDot) + ' ' + $Text) }
  function Write-Warn([string]$Text) { Write-Host ('  ' + (Paint '33' '!') + ' ' + $Text) }
  function Write-Fail([string]$Text) { Write-Host ('  ' + (Paint '31' $gErr) + ' ' + $Text) }
  function Write-Command([string]$Text) { Write-Host ('    ' + (Paint '36' $Text)) }
  function Write-Heading([string]$Text) { Write-Host ''; Write-Host ('  ' + (Paint '1' $Text)) }

  function Write-Header {
    Write-Host ''
    Write-Host ('  ' + (Paint '1;36' 'memory-kit') + '  ' + (Paint '90' 'installer'))
    Write-Host ('  ' + (Paint '90' 'a private memory for your AI tools'))
    Write-Host ('  ' + (Paint '90' ($gRule * 34)))
    Write-Host ''
  }

  function Write-Usage {
    Say 'memory-kit installer (Windows PowerShell 5.1, PowerShell 7)'
    Say ''
    Say '  irm https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.ps1 | iex'
    Say '  & ([scriptblock]::Create((irm https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.ps1))) [parameters]'
    Say ''
    Say 'parameters:'
    Say '  -Dir <path>          memory folder (default $HOME\memory)       MEMORY_KIT_DIR'
    Say '  -Yes                 ask nothing                               MEMORY_KIT_YES=1'
    Say '  -NoGh                never use the GitHub CLI                  MEMORY_KIT_NO_GH=1'
    Say '  -Source <url|dir>    kit repository or a local kit folder      MEMORY_KIT_SOURCE'
    Say '  -Ref <tag|branch>    kit version (default: newest v* tag)      MEMORY_KIT_REF'
    Say '  -Mode github|local|combined                                    MEMORY_KIT_MODE'
    Say '  -Lang en|cs                                                    MEMORY_KIT_LANG'
    Say '  -Sectors core,work,...                                         MEMORY_KIT_SECTORS'
    Say '  -Help'
    Say ''
    Say 'exit codes: 0 done, 1 a step failed, 2 usage or missing prerequisite, 3 refused, 130 cancelled'
  }

  # A path as the reader knows it: ~ for the home folder.
  function Format-Path([string]$Path) {
    if ($HOME -and $Path.StartsWith($HOME, [StringComparison]::OrdinalIgnoreCase)) {
      $rest = $Path.Substring($HOME.Length)
      if ($rest -eq '') { return '~' }
      if ($rest.StartsWith('\') -or $rest.StartsWith('/')) { return '~' + $rest }
    }
    return $Path
  }

  # One argument for a copy-pasted PowerShell command (single quotes only when needed).
  function Format-Arg([string]$Text) {
    if ($Text -match '^[A-Za-z0-9_.:\\/,=@+-]+$') { return $Text }
    return "'" + $Text.Replace("'", "''") + "'"
  }

  # Ends the run with an exit code; caught at the bottom.
  function Stop-Install([int]$Code) {
    $st.code = $Code
    throw 'memory-kit-stop'
  }

  # -------------------------------------------------------------------------------------------
  # Native commands. Arguments go as an array (PowerShell quotes each one); never an empty string
  # or one with a double quote, which Windows PowerShell 5.1 drops or mangles.

  # Runs a program for its output: { code; out }. stderr is dropped; the local preference Continue
  # keeps Windows PowerShell 5.1 from turning redirected stderr into a terminating error.
  function Invoke-Quiet([string]$Exe, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $out = @()
    try {
      $out = @(& $Exe @Arguments 2>$null)
      $code = $LASTEXITCODE
    } catch {
      $code = 1
    }
    return @{ code = $code; out = $out }
  }

  # The first line of a command's output, trimmed; '' when there is none.
  function Get-FirstLine($Lines) {
    foreach ($entry in @($Lines)) {
      if ($null -ne $entry) { return ([string]$entry).Trim() }
    }
    return ''
  }

  function Find-App([string]$Name) {
    $found = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.Path }
    return ''
  }

  # Adds the Machine and User PATH of the registry to this session (a program installed after the
  # window opened is not on its PATH yet). True when that changed something.
  function Update-SessionPath {
    if (-not $onWindows) { return $false }
    $parts = @()
    foreach ($scope in @('Machine', 'User')) {
      $value = [Environment]::GetEnvironmentVariable('Path', $scope)
      if ($value) { $parts += $value }
    }
    if ($parts.Count -eq 0) { return $false }
    $fresh = ($parts -join ';') + ';' + $env:Path
    if ($fresh -eq $env:Path) { return $false }
    $env:Path = $fresh
    return $true
  }

  # -------------------------------------------------------------------------------------------
  # Options

  function Get-Option([string]$Value, [string]$EnvName) {
    if ($Value) { return $Value }
    $fromEnv = [Environment]::GetEnvironmentVariable($EnvName)
    if ($fromEnv) { return $fromEnv }
    return ''
  }

  function Test-True([string]$Value) {
    return @('1', 'true', 'yes') -contains $Value
  }

  function Stop-Usage([string]$Text) {
    Write-Fail $Text
    Say '    run with -Help for the parameters'
    Stop-Install 2
  }

  function Resolve-FullPath([string]$Path) {
    if ($Path -eq '~') { $Path = $HOME }
    elseif ($Path.StartsWith('~\') -or $Path.StartsWith('~/')) { $Path = Join-Path $HOME $Path.Substring(2) }
    $full = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    while ($full.Length -gt $root.Length -and ($full.EndsWith('\') -or $full.EndsWith('/'))) {
      $full = $full.Substring(0, $full.Length - 1)
    }
    return $full
  }

  # Fills $opt from the parameters and the environment.
  function Read-Options {
    $o = $opt
    $o.dir = Get-Option $P.Dir 'MEMORY_KIT_DIR'
    $o.dirGiven = [bool]$o.dir
    $o.yes = [bool]$P.Yes -or (Test-True ([string]$env:MEMORY_KIT_YES))
    $o.noGh = [bool]$P.NoGh -or (Test-True ([string]$env:MEMORY_KIT_NO_GH))
    $o.source = Get-Option $P.Source 'MEMORY_KIT_SOURCE'
    $o.ref = Get-Option $P.Ref 'MEMORY_KIT_REF'
    $o.mode = Get-Option $P.Mode 'MEMORY_KIT_MODE'
    $o.lang = Get-Option $P.Lang 'MEMORY_KIT_LANG'
    $o.sectors = Get-Option (@($P.Sectors) -join ',') 'MEMORY_KIT_SECTORS'
    if ($o.mode -and @('github', 'local', 'combined') -notcontains $o.mode) { Stop-Usage '-Mode must be github, local or combined' }
    if ($o.lang -and $o.lang -cnotmatch '^[a-z-]+$') { Stop-Usage '-Lang must be a language code such as en or cs' }
    if ($o.sectors -and $o.sectors -notmatch '^[A-Za-z0-9,:_-]+$') { Stop-Usage '-Sectors must be a list such as core,work' }
    if ($o.ref -and ($o.ref.StartsWith('-') -or $o.ref -notmatch '^[A-Za-z0-9._/-]+$')) { Stop-Usage '-Ref must be a tag or branch name' }
    if ($o.source.StartsWith('-')) { Stop-Usage '-Source must be a git URL or a folder' }
    if (-not $o.dir) { $o.dir = Join-Path $HOME 'memory' }
    $o.dir = Resolve-FullPath $o.dir
    $o.sourceDefault = -not $o.source
    if ($o.sourceDefault) { $o.source = $KitUrlDefault }
    $o.local = $false
    if ($o.source -notmatch '^[A-Za-z][A-Za-z0-9+.-]*://' -and $o.source -notmatch '^[^@\s/\\]+@[^:\s]+:') {
      $full = Resolve-FullPath $o.source
      if (Test-Path -LiteralPath $full -PathType Container) {
        $o.source = $full
        $o.local = $true
      }
    }
  }

  # -------------------------------------------------------------------------------------------
  # Interactivity

  function Test-Interactive {
    if ($opt.yes -or $env:CI) { return $false }
    try {
      return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected
    } catch {
      return $false
    }
  }

  function Read-Answer([string]$Question, [string]$Hint) {
    Write-Host ('  ' + (Paint '36' '?') + ' ' + $Question + ' ' + (Paint '90' ('[' + $Hint + ']')) + ' ') -NoNewline
    $answer = Read-Host
    if ($null -eq $answer) { return '' }
    return $answer.Trim()
  }

  function Confirm-Step([string]$Question, [bool]$Default) {
    if (-not $st.interactive) { return $Default }
    $hint = 'y/N'
    if ($Default) { $hint = 'Y/n' }
    $answer = Read-Answer $Question $hint
    if ($answer -eq '') { return $Default }
    return @('y', 'yes', 'a', 'ano') -contains $answer
  }

  # -------------------------------------------------------------------------------------------
  # Prerequisites: report, never install.

  function Test-Node {
    $st.node = Find-App 'node'
    if (-not $st.node -and $onWindows -and $env:ProgramFiles) {
      $candidate = Join-Path (Join-Path $env:ProgramFiles 'nodejs') 'node.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) { $st.node = $candidate }
    }
    if (-not $st.node) { return @{ state = 'missing'; version = '' } }
    $r = Invoke-Quiet $st.node @('-p', 'process.versions.node')
    $version = Get-FirstLine $r.out
    if ($r.code -ne 0 -or $version -notmatch '^(\d+)\.(\d+)\.(\d+)') { return @{ state = 'broken'; version = '' } }
    $major = [int]$Matches[1]
    $minor = [int]$Matches[2]
    $state = 'ok'
    if ($major -lt $NodeMinMajor -or ($major -eq $NodeMinMajor -and $minor -lt $NodeMinMinor)) { $state = 'old' }
    elseif ($major -eq $NodeMinMajor -and $minor -lt $NodeFastMinor) { $state = 'slow' }
    return @{ state = $state; version = $version }
  }

  function Test-Git {
    $st.git = Find-App 'git'
    if (-not $st.git) { return @{ state = 'missing'; version = '' } }
    $r = Invoke-Quiet $st.git @('--version')
    $version = Get-FirstLine $r.out
    if ($r.code -ne 0) { return @{ state = 'missing'; version = '' } }
    return @{ state = 'ok'; version = ($version -replace '^git version ', '') }
  }

  function Write-InstallAdvice([hashtable]$NodeInfo, [hashtable]$GitInfo) {
    $needNode = @('ok', 'slow') -notcontains $NodeInfo.state
    $needGit = $GitInfo.state -ne 'ok'
    Write-Heading 'Install what is missing, then open a new terminal and run the installer again:'
    if ($onWindows -and (Find-App 'winget')) {
      if ($needNode) { Write-Command 'winget install --id OpenJS.NodeJS.LTS -e --source winget' }
      if ($needGit) { Write-Command 'winget install --id Git.Git -e --source winget' }
      if ($needNode) { Write-Note 'the Node.js installer asks for administrator rights once (UAC)' }
      Write-Note 'or, instead of a new terminal, refresh PATH in this one:'
      Write-Command "`$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"
    } else {
      if ($needNode) { Write-Note 'Node.js 24 LTS: https://nodejs.org/en/download' }
      if ($needGit) { Write-Note 'git: https://git-scm.com/downloads' }
    }
    Say ''
  }

  function Test-Prerequisites {
    $gitInfo = Test-Git
    $nodeInfo = Test-Node
    $ready = ($gitInfo.state -eq 'ok') -and (@('ok', 'slow') -contains $nodeInfo.state)
    if (-not $ready -and (Update-SessionPath)) {
      $gitInfo = Test-Git
      $nodeInfo = Test-Node
      $ready = ($gitInfo.state -eq 'ok') -and (@('ok', 'slow') -contains $nodeInfo.state)
      if ($ready) { Write-Note 'PATH of this window refreshed from the system settings' }
    }
    if ($gitInfo.state -eq 'ok') { Write-Ok ('git ' + $gitInfo.version) } else { Write-Fail 'git is missing' }
    $need = [string]$NodeMinMajor + '.' + [string]$NodeMinMinor
    switch ($nodeInfo.state) {
      'ok' { Write-Ok ('Node.js ' + $nodeInfo.version) }
      'slow' { Write-Warn ('Node.js ' + $nodeInfo.version + ' works; search is faster from Node.js ' + [string]$NodeMinMajor + '.' + [string]$NodeFastMinor + ' (node:sqlite with FTS5)') }
      'old' { Write-Fail ('Node.js ' + $nodeInfo.version + ' is too old: memory-kit needs ' + $need + ' or newer') }
      'broken' { Write-Fail 'node is on PATH but did not report a version' }
      default { Write-Fail ('Node.js is missing: memory-kit needs ' + $need + ' or newer') }
    }
    if (-not $ready) {
      Write-InstallAdvice $nodeInfo $gitInfo
      Stop-Install 2
    }
    $email = Invoke-Quiet $st.git @('config', 'user.email')
    if (-not $env:GIT_AUTHOR_EMAIL -and -not $env:EMAIL -and -not (Get-FirstLine $email.out)) {
      Write-Warn 'git has no identity yet (needed for the first commit):'
      Write-Command 'git config --global user.name "Your Name"'
      Write-Command 'git config --global user.email "you@example.com"'
    }
  }

  function Test-Refused {
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
      Write-Fail 'PowerShell runs in constrained language mode here, so the installer cannot run.'
      Stop-Install 3
    }
    if (-not $onWindows -or (Test-True ([string]$env:MEMORY_KIT_ALLOW_ADMIN))) { return }
    $elevated = $false
    try {
      $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
      $elevated = ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch { $elevated = $false }
    if ($elevated) {
      Write-Fail 'do not run the installer as administrator: git would then refuse the folder as owned by someone else. Open a normal PowerShell window.'
      Stop-Install 3
    }
  }

  function Set-Tls12 {
    if ($PSVersionTable.PSVersion.Major -ge 6) { return }
    try {
      $current = [Net.ServicePointManager]::SecurityProtocol
      if ($current.ToString() -ne 'SystemDefault' -and -not ([int]$current -band 3072)) {
        [Net.ServicePointManager]::SecurityProtocol = [int]$current -bor 3072
      }
    } catch { }
  }

  # -------------------------------------------------------------------------------------------
  # The target folder

  # new (missing or empty), vault (set up), kit (downloaded, setup not finished) or other.
  function Get-DirState([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return 'new' }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return 'other' }
    if (@(Get-ChildItem -LiteralPath $Path -Force).Count -eq 0) { return 'new' }
    $config = Join-Path $Path 'memory.json'
    $cli = Join-Path (Join-Path $Path 'system') 'memory.mjs'
    if (-not (Test-Path -LiteralPath $config -PathType Leaf) -or -not (Test-Path -LiteralPath $cli -PathType Leaf)) { return 'other' }
    try {
      $parsed = [IO.File]::ReadAllText($config) | ConvertFrom-Json
      if ($parsed.initialized -eq $true) { return 'vault' }
      return 'kit'
    } catch {
      return 'vault'
    }
  }

  function Get-PublicKitRemote([string]$Path) {
    if (-not (Test-Path -LiteralPath (Join-Path $Path '.git'))) { return '' }
    $r = Invoke-Quiet $st.git @('-C', $Path, 'remote', '-v')
    foreach ($entry in $r.out) {
      $parts = -split [string]$entry
      if ($parts.Count -ge 2 -and $parts[1] -match '8krystof8/memory-kit(\.git)?/?$') { return $parts[1] }
    }
    return ''
  }

  function Test-PublicRemote {
    $remote = Get-PublicKitRemote $opt.dir
    if ($remote) {
      Write-Fail ((Format-Path $opt.dir) + ' is a clone of the public kit repository (' + $remote + ').')
      Write-Note 'Personal notes must never be pushed there. Remove that remote, or choose another folder:'
      Write-Command ('git -C ' + (Format-Arg $opt.dir) + ' remote remove origin')
      Stop-Install 3
    }
  }

  # -------------------------------------------------------------------------------------------
  # Getting the kit

  function Get-SourceLabel {
    if ($opt.sourceDefault) { return 'github.com/' + $KitTemplate }
    return $opt.source
  }

  # The newest vX.Y.Z tag of a git URL, '' without tags, $null when git cannot reach it.
  function Get-NewestTag([string]$Url) {
    $r = Invoke-Quiet $st.git @('ls-remote', '--tags', $Url)
    if ($r.code -ne 0) { return $null }
    $best = $null
    $bestTag = ''
    foreach ($entry in $r.out) {
      if ([string]$entry -match 'refs/tags/(v(\d+)\.(\d+)\.(\d+))$') {
        $tag = $Matches[1]
        $version = New-Object -TypeName System.Version -ArgumentList ([int]$Matches[2]), ([int]$Matches[3]), ([int]$Matches[4])
        if ($null -eq $best -or $version -gt $best) {
          $best = $version
          $bestTag = $tag
        }
      }
    }
    return $bestTag
  }

  function Resolve-Ref {
    if ($st.ref -or $opt.local) { return }
    $tag = Get-NewestTag $opt.source
    if ($null -eq $tag) {
      Write-Fail ('cannot reach ' + (Get-SourceLabel) + ' (git ls-remote failed). Check the network, or pass -Source.')
      Stop-Install 1
    }
    $st.ref = $tag
  }

  function Copy-KitFolder([string]$From, [string]$To) {
    $null = [IO.Directory]::CreateDirectory($To)
    foreach ($item in @(Get-ChildItem -LiteralPath $From -Force)) {
      if (@('.git', '.memory-kit', 'node_modules', '.cache', '.trash') -contains $item.Name) { continue }
      Copy-Item -LiteralPath $item.FullName -Destination $To -Recurse -Force
    }
  }

  # Puts the kit into $Dest (a new folder) as a fresh git repository with no remote and no history.
  function Get-Kit([string]$Dest) {
    if ($opt.local -and -not $st.ref) {
      if (-not (Test-Path -LiteralPath (Join-Path (Join-Path $opt.source 'system') 'init.mjs') -PathType Leaf)) {
        Write-Fail ($opt.source + ' is not a memory-kit folder (system\init.mjs is missing)')
        Stop-Install 1
      }
      Copy-KitFolder $opt.source $Dest
    } else {
      $argv = @('-c', 'advice.detachedHead=false', 'clone', '--quiet', '--depth', '1')
      if ($opt.local) { $argv += '--no-local' }
      if ($st.ref) { $argv += @('--branch', $st.ref) }
      $argv += @('--', $opt.source, $Dest)
      & $st.git @argv
      if ($LASTEXITCODE -ne 0) {
        $at = ''
        if ($st.ref) { $at = ' at ' + $st.ref }
        Write-Fail ('git clone of ' + (Get-SourceLabel) + $at + ' failed (see above)')
        Stop-Install 1
      }
    }
    $gitDir = Join-Path $Dest '.git'
    if (Test-Path -LiteralPath $gitDir) { Remove-Item -LiteralPath $gitDir -Recurse -Force }
    & $st.git init --quiet $Dest
    $ok = $LASTEXITCODE -eq 0
    if ($ok) {
      & $st.git -C $Dest symbolic-ref HEAD refs/heads/main
      $ok = $LASTEXITCODE -eq 0
    }
    if (-not $ok) {
      Write-Fail ('git init in ' + (Format-Path $Dest) + ' failed')
      Stop-Install 1
    }
  }

  # True when gh can make the repository: installed, logged in, not refused, the default source,
  # and a mode that allows a remote. $st.ghReason says why not.
  function Test-Gh {
    if ($opt.noGh) { $st.ghReason = 'not used (-NoGh)'; return $false }
    if (-not $opt.sourceDefault) { $st.ghReason = 'not used (-Source)'; return $false }
    if ($opt.mode -eq 'local') { $st.ghReason = 'not used (mode local keeps everything on this computer)'; return $false }
    $st.gh = Find-App 'gh'
    if (-not $st.gh) { $st.ghReason = 'not installed (optional)'; return $false }
    if ((Invoke-Quiet $st.gh @('auth', 'status')).code -ne 0) { $st.ghReason = 'not logged in (optional: gh auth login)'; return $false }
    $user = Get-FirstLine (Invoke-Quiet $st.gh @('api', 'user', '--jq', '.login')).out
    if (-not $user) { $st.ghReason = 'cannot read the GitHub account'; return $false }
    $st.ghUser = $user
    $name = ([IO.Path]::GetFileName($opt.dir) -replace '[^A-Za-z0-9._-]+', '-').Trim('-')
    if (-not $name) { $name = 'memory' }
    $st.ghName = $name
    return $true
  }

  function Select-Method {
    $st.useGh = $false
    if (-not (Test-Gh)) {
      Write-Note ('GitHub CLI ' + $st.ghReason)
      return
    }
    if ($st.interactive) {
      $st.useGh = Confirm-Step ('Create the private GitHub repository ' + $st.ghUser + '/' + $st.ghName + ' for it?') $true
    } elseif ($opt.mode) {
      $st.useGh = $true
    }
    if ($st.useGh) { Write-Ok ('GitHub CLI logged in as ' + $st.ghUser) }
    else { Write-Note 'GitHub CLI not used: a local repository without a remote' }
  }

  function New-WithGh([string]$Staging) {
    $full = $st.ghUser + '/' + $st.ghName
    if ((Invoke-Quiet $st.gh @('repo', 'view', $full)).code -eq 0) {
      Write-Fail ('the repository ' + $full + ' exists already. Clone it, or choose another -Dir:')
      Write-Command ('gh repo clone ' + $full + ' ' + (Format-Arg $opt.dir))
      Stop-Install 1
    }
    Push-Location -LiteralPath $Staging
    try {
      & $st.gh repo create $st.ghName --template $KitTemplate --private --clone
      $created = $LASTEXITCODE -eq 0
    } finally {
      Pop-Location
    }
    if (-not $created) {
      Write-Fail 'gh repo create failed (see above). To make the memory without GitHub, run the installer with -NoGh.'
      Stop-Install 1
    }
    $visibility = Get-FirstLine (Invoke-Quiet $st.gh @('repo', 'view', $full, '--json', 'visibility', '--jq', '.visibility')).out
    if ($visibility -ne 'PRIVATE') {
      Write-Fail ($full + ' is not private (' + $visibility + '). Make it private on GitHub before you add notes.')
      Stop-Install 3
    }
  }

  function Read-KitVersion {
    $file = Join-Path (Join-Path $opt.dir 'system') 'VERSION'
    if (Test-Path -LiteralPath $file -PathType Leaf) { return ([IO.File]::ReadAllText($file)).Trim() }
    return '?'
  }

  function New-Vault {
    $parent = [IO.Path]::GetDirectoryName($opt.dir)
    $null = [IO.Directory]::CreateDirectory($parent)
    $st.staging = Join-Path $parent ('.memory-kit-install.' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    $null = [IO.Directory]::CreateDirectory($st.staging)
    if ($st.useGh) {
      New-WithGh $st.staging
      $made = Join-Path $st.staging $st.ghName
    } else {
      $made = Join-Path $st.staging 'kit'
      Get-Kit $made
    }
    if (Test-Path -LiteralPath $opt.dir) { Remove-Item -LiteralPath $opt.dir -Force }
    [IO.Directory]::Move($made, $opt.dir)
    Remove-Item -LiteralPath $st.staging -Recurse -Force
    $st.staging = ''
    $version = Read-KitVersion
    if ($st.useGh) {
      Write-Ok ('memory-kit ' + $version + ' in the private repository ' + $st.ghUser + '/' + $st.ghName)
    } else {
      $at = ''
      if ($st.ref) { $at = ' (' + $st.ref + ')' }
      Write-Ok ('memory-kit ' + $version + ' from ' + (Get-SourceLabel) + $at)
      Write-Ok 'fresh git repository, no remote, none of the kit history'
    }
  }

  # -------------------------------------------------------------------------------------------
  # Setup (init) and the existing-vault flow

  function Test-Answers { return [bool]($opt.mode -and $opt.lang -and $opt.sectors) }

  function Write-FinishHint {
    $mode = 'github'
    $lang = 'en'
    $sectors = 'core,work'
    if ($opt.mode) { $mode = $opt.mode }
    if ($opt.lang) { $lang = $opt.lang }
    if ($opt.sectors) { $sectors = $opt.sectors }
    Write-Command ('cd ' + (Format-Arg $opt.dir))
    Write-Command 'node system/init.mjs'
    Write-Note 'or with the answers (--mode github, local or combined; --lang en or cs):'
    Write-Command ('node system/init.mjs --mode ' + $mode + ' --lang ' + $lang + ' --sectors ' + $sectors + ' --yes')
  }

  function Invoke-Setup {
    $argv = @((Join-Path (Join-Path $opt.dir 'system') 'init.mjs'), '--root', $opt.dir)
    if ($opt.mode) { $argv += @('--mode', $opt.mode) }
    if ($opt.lang) { $argv += @('--lang', $opt.lang) }
    if ($opt.sectors) { $argv += @('--sectors', $opt.sectors) }
    if (Test-Answers) { $argv += '--yes' }
    if (-not $st.interactive -and -not (Test-Answers)) {
      Write-Warn 'The kit is in place; the setup needs answers. Finish it with:'
      Write-FinishHint
      Say ''
      Stop-Install 2
    }
    Write-Note 'setup: node system/init.mjs'
    Say ''
    & $st.node @argv
    $code = $LASTEXITCODE
    Say ''
    if ($code -ne 0) {
      Write-Fail ('the setup did not finish (init exit ' + [string]$code + '). Nothing is lost: run it again:')
      Write-FinishHint
      Say ''
      if ($code -eq 2) { Stop-Install 2 }
      Stop-Install 1
    }
  }

  function Write-Summary {
    Write-Ok ('Your memory is ready: ' + (Format-Path $opt.dir))
    Write-Heading 'Next'
    Write-Command ('cd ' + (Format-Arg $opt.dir))
    $status = Invoke-Quiet $st.git @('-C', $opt.dir, 'status', '--porcelain')
    if ($status.code -eq 0 -and $status.out.Count -gt 0) {
      Write-Command 'git add -A'
      Write-Command 'git commit -m "Set up memory"'
    }
    if ($st.useGh) { Write-Command 'git push' }
    Write-Command 'node system/memory.mjs doctor'
    Write-Command 'node system/memory.mjs connect --list'
    Write-Note 'connect --list shows your AI apps; node system/memory.mjs connect <app> links one'
    Say ''
  }

  # upgrade [extra] [--from <source>] [--ref <ref>]: the vault's own upgrade, with this run's source.
  function Get-UpgradeArgs([string[]]$Extra) {
    $argv = @((Join-Path (Join-Path $opt.dir 'system') 'memory.mjs'), 'upgrade', '--root', $opt.dir) + $Extra
    if (-not $opt.sourceDefault) { $argv += @('--from', $opt.source) }
    if ($st.ref) { $argv += @('--ref', $st.ref) }
    return , $argv
  }

  # What `upgrade --json` says: @{ state = 'current'|'available'|'other'; from; to }.
  function Get-UpgradeStatus {
    $r = Invoke-Quiet $st.node (Get-UpgradeArgs @('--json'))
    $text = @($r.out) -join "`n"
    $report = $null
    try {
      if ($text.IndexOf('{') -ge 0) { $report = $text.Substring($text.IndexOf('{')) | ConvertFrom-Json }
    } catch { $report = $null }
    if ($report -and $report.result -and $report.result.up_to_date) {
      return @{ state = 'current'; from = [string]$report.result.installed; to = '' }
    }
    if ($report -and $report.result -and $report.result.dry_run -and $report.plan) {
      return @{ state = 'available'; from = [string]$report.plan.from; to = [string]$report.plan.to }
    }
    return @{ state = 'other'; from = ''; to = '' }
  }

  function Get-UpgradeShown {
    $shown = 'node system/memory.mjs upgrade'
    if (-not $opt.sourceDefault) { $shown += ' --from ' + (Format-Arg $opt.source) }
    if ($st.ref) { $shown += ' --ref ' + $st.ref }
    return $shown
  }

  function Invoke-VaultFlow {
    Write-Ok ('memory-kit ' + (Read-KitVersion) + ' is set up in ' + (Format-Path $opt.dir) + ' already; nothing was downloaded')
    if (-not $st.ref -and -not $opt.local) {
      $tag = Get-NewestTag $opt.source
      if ($tag) { $st.ref = $tag }
    }
    if (-not $st.interactive) {
      Write-Heading 'To check and update it:'
      Write-Command ('cd ' + (Format-Arg $opt.dir))
      Write-Command 'node system/memory.mjs doctor'
      Write-Command (Get-UpgradeShown)
      Say ''
      return
    }
    if (Confirm-Step 'Check it with doctor now?' $true) {
      Say ''
      & $st.node (Join-Path (Join-Path $opt.dir 'system') 'memory.mjs') doctor --root $opt.dir
      Say ''
    }
    Write-Note 'looking for a newer memory-kit'
    $status = Get-UpgradeStatus
    if ($status.state -eq 'current') {
      Write-Ok ('memory-kit ' + $status.from + ' is up to date')
    } elseif ($status.state -eq 'available') {
      Write-Ok ('memory-kit ' + $status.to + ' is available (this memory has ' + $status.from + ')')
      if (Confirm-Step 'Upgrade now? A backup comes first; upgrade --rollback undoes it.' $true) {
        Say ''
        $argv = Get-UpgradeArgs @('--yes')
        & $st.node @argv
      }
    } else {
      Say ''
      $argv = Get-UpgradeArgs @()
      & $st.node @argv
    }
    Say ''
  }

  function Invoke-Main {
    if ($P.Help) {
      Write-Usage
      return
    }
    Read-Options
    $st.ref = $opt.ref
    Write-Header
    Test-Refused
    Set-Tls12
    $st.interactive = Test-Interactive
    Test-Prerequisites
    if ($st.interactive -and -not $opt.dirGiven) {
      $answer = Read-Answer 'Folder for your memory' (Format-Path $opt.dir)
      if ($answer) { $opt.dir = Resolve-FullPath $answer }
    }
    switch (Get-DirState $opt.dir) {
      'other' {
        Write-Fail ((Format-Path $opt.dir) + ' exists and is not a memory-kit folder. Choose another folder with -Dir.')
        Stop-Install 3
      }
      'vault' {
        Test-PublicRemote
        Invoke-VaultFlow
        return
      }
      'kit' {
        Test-PublicRemote
        Write-Ok ('memory-kit is downloaded in ' + (Format-Path $opt.dir) + '; continuing with the setup')
      }
      default {
        Resolve-Ref
        Select-Method
        if ($st.interactive -and -not (Confirm-Step ('Create the memory in ' + (Format-Path $opt.dir) + '?') $true)) {
          Write-Note 'Nothing was changed.'
          Stop-Install 130
        }
        New-Vault
      }
    }
    Invoke-Setup
    Write-Summary
  }

  $savedPrompt = $env:GIT_TERMINAL_PROMPT
  $env:GIT_TERMINAL_PROMPT = '0'
  try {
    Invoke-Main
  } catch {
    if ([string]$_.Exception.Message -ne 'memory-kit-stop') {
      Write-Fail ('unexpected error: ' + $_.Exception.Message)
      if ($env:MEMORY_DEBUG) { Write-Host $_.ScriptStackTrace }
      $st.code = 1
    }
  } finally {
    if ($st.staging -and (Test-Path -LiteralPath $st.staging)) {
      Remove-Item -LiteralPath $st.staging -Recurse -Force -ErrorAction SilentlyContinue
    }
    if ($null -eq $savedPrompt) { Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue }
    else { $env:GIT_TERMINAL_PROMPT = $savedPrompt }
  }
  if ($FromFile) { exit $st.code }
  $global:LASTEXITCODE = $st.code
} @{ Dir = $Dir; Yes = $Yes; NoGh = $NoGh; Source = $Source; Ref = $Ref; Mode = $Mode; Lang = $Lang; Sectors = $Sectors; Help = $Help } ([bool]$MyInvocation.MyCommand.Path)
