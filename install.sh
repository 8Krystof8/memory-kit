#!/bin/sh
# memory-kit installer for macOS and Linux: a private memory in one command.
#
#   curl -fsSL https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.sh | sh
#
# With the answers, so nothing is asked (arguments go after `sh -s --`):
#
#   curl -fsSL https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.sh | sh -s -- --yes --mode local --lang en --sectors core,work
#
# It checks git and Node.js 22.5 or newer (it never installs them and never runs sudo: it prints
# the commands), then creates the memory folder (default ~/memory). With the GitHub CLI logged in
# it offers a new PRIVATE repository made from the template. Otherwise it downloads the kit without
# its history and starts a fresh git repository with no remote, so a note can never be pushed to
# the public kit repository. Then it runs the setup (node system/init.mjs). A folder that already
# holds a memory is left alone: the installer offers doctor and upgrade instead.
#
# Options (environment variable in brackets):
#   --dir <path>          the memory folder (MEMORY_KIT_DIR; default ~/memory)
#   --yes                 ask nothing (MEMORY_KIT_YES=1); the setup then needs the three answers
#   --no-gh               never use the GitHub CLI (MEMORY_KIT_NO_GH=1)
#   --source <url|dir>    where the kit comes from (MEMORY_KIT_SOURCE; default the public kit
#                         repository); a folder is copied as it is, or cloned at --ref
#   --ref <tag|branch>    the kit version (MEMORY_KIT_REF; default the newest v* tag, else the
#                         default branch)
#   --mode, --lang, --sectors   setup answers, passed to init (MEMORY_KIT_MODE, MEMORY_KIT_LANG,
#                         MEMORY_KIT_SECTORS)
# NO_COLOR turns colors off. Exit codes: 0 done, 1 a step failed, 2 a usage error or a missing
# prerequisite, 3 refused (the folder is in the way, or run through sudo; MEMORY_KIT_ALLOW_ROOT=1
# allows root), 130 cancelled.
#
# POSIX sh only (dash, bash 3.2 as sh on macOS, busybox ash): no arrays, no `local`, no pipefail.
# Everything below sits in one { } group that ends with the call of main: the shell reads the whole
# group before it runs any of it, so a download cut short anywhere runs nothing (a syntax error),
# and nothing the installer starts can read the rest of the script from stdin.

{
set -eu

KIT_URL_DEFAULT=https://github.com/8Krystof8/memory-kit.git
KIT_TEMPLATE=8Krystof8/memory-kit
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=5
NODE_FAST_MINOR=13

# ---------------------------------------------------------------------------------------------
# Output: two-space margin, one accent color, ASCII glyphs when the locale is not UTF-8.

setup_style() {
  C_ACCENT='' C_OK='' C_WARN='' C_ERR='' C_DIM='' C_BOLD='' C_RESET=''
  color=0
  if [ -t 1 ] && [ -z "${NO_COLOR-}" ] && [ "${TERM-}" != dumb ]; then color=1; fi
  case ${FORCE_COLOR-} in '' | 0 | false) ;; *) color=1 ;; esac
  if [ "$color" = 1 ]; then
    C_ACCENT=$(printf '\033[36m')
    C_OK=$(printf '\033[32m')
    C_WARN=$(printf '\033[33m')
    C_ERR=$(printf '\033[31m')
    C_DIM=$(printf '\033[90m')
    C_BOLD=$(printf '\033[1m')
    C_RESET=$(printf '\033[0m')
  fi
  locale_name=${LC_ALL:-${LC_CTYPE:-${LANG-}}}
  case $locale_name in
    *UTF-8* | *utf-8* | *UTF8* | *utf8*) unicode=1 ;;
    *) unicode=0 ;;
  esac
  if [ "${TERM-}" = linux ]; then unicode=0; fi
  if [ "$unicode" = 1 ]; then
    G_OK=$(printf '\342\234\223')
    G_ERR=$(printf '\342\234\227')
    G_DOT=$(printf '\302\267')
    G_RULE=$(printf '\342\224\200')
  else
    G_OK='+' G_ERR='x' G_DOT='-' G_RULE='-'
  fi
}

line() { printf '%s\n' "$*"; }
ok() { printf '  %s%s%s %s\n' "$C_OK" "$G_OK" "$C_RESET" "$*"; }
note() { printf '  %s%s%s %s\n' "$C_DIM" "$G_DOT" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_RESET" "$*"; }
fail() { printf '  %s%s%s %s\n' "$C_ERR" "$G_ERR" "$C_RESET" "$*" >&2; }
command_line() { printf '    %s%s%s\n' "$C_ACCENT" "$*" "$C_RESET"; }
heading() { printf '\n  %s%s%s\n' "$C_BOLD" "$*" "$C_RESET"; }

header() {
  rule=''
  i=0
  while [ "$i" -lt 34 ]; do
    rule="$rule$G_RULE"
    i=$((i + 1))
  done
  printf '\n  %s%smemory-kit%s  %sinstaller%s\n' "$C_BOLD" "$C_ACCENT" "$C_RESET" "$C_DIM" "$C_RESET"
  printf '  %sa private memory for your AI tools%s\n' "$C_DIM" "$C_RESET"
  printf '  %s%s%s\n\n' "$C_DIM" "$rule" "$C_RESET"
}

usage() {
  cat <<'EOF'
memory-kit installer (macOS, Linux)

  curl -fsSL https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/8Krystof8/memory-kit/main/install.sh | sh -s -- [options]

options:
  --dir <path>          memory folder (default ~/memory)          MEMORY_KIT_DIR
  --yes                 ask nothing                               MEMORY_KIT_YES=1
  --no-gh               never use the GitHub CLI                  MEMORY_KIT_NO_GH=1
  --source <url|dir>    kit repository or a local kit folder      MEMORY_KIT_SOURCE
  --ref <tag|branch>    kit version (default: newest v* tag)      MEMORY_KIT_REF
  --mode github|local|combined                                    MEMORY_KIT_MODE
  --lang en|cs                                                    MEMORY_KIT_LANG
  --sectors core,work,...                                         MEMORY_KIT_SECTORS
  --help

exit codes: 0 done, 1 a step failed, 2 usage or missing prerequisite, 3 refused, 130 cancelled
EOF
}

# Prints a path for the reader: ~ for the home folder.
pretty_path() {
  case $1 in
    "${HOME:-/nonexistent}") printf '~' ;;
    "${HOME:-/nonexistent}"/*) printf '%s/%s' '~' "${1#"$HOME"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Quotes one argument for a copy-pasted sh command (only when it needs it).
shell_quote() {
  case $1 in
    '' | *[!A-Za-z0-9_./:=,@+-]*) printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")" ;;
    *) printf '%s' "$1" ;;
  esac
}

# ---------------------------------------------------------------------------------------------
# Arguments

usage_error() {
  fail "$1"
  printf '  run with --help for the options\n' >&2
  exit 2
}

is_true() {
  case ${1-} in 1 | true | yes | TRUE | YES | True | Yes) return 0 ;; *) return 1 ;; esac
}

parse_args() {
  MK_DIR=${MEMORY_KIT_DIR-}
  MK_DIR_GIVEN=0
  if [ -n "$MK_DIR" ]; then MK_DIR_GIVEN=1; fi
  MK_YES=0
  if is_true "${MEMORY_KIT_YES-}"; then MK_YES=1; fi
  MK_NO_GH=0
  if is_true "${MEMORY_KIT_NO_GH-}"; then MK_NO_GH=1; fi
  MK_SOURCE=${MEMORY_KIT_SOURCE-}
  MK_REF=${MEMORY_KIT_REF-}
  MK_MODE=${MEMORY_KIT_MODE-}
  MK_LANG=${MEMORY_KIT_LANG-}
  MK_SECTORS=${MEMORY_KIT_SECTORS-}
  while [ $# -gt 0 ]; do
    opt=$1
    case $opt in
      --*=*)
        value=${opt#*=}
        opt=${opt%%=*}
        shift
        set -- "$opt" "$value" "$@"
        ;;
    esac
    case $opt in
      --yes | -y) MK_YES=1; shift; continue ;;
      --no-gh) MK_NO_GH=1; shift; continue ;;
      -h | --help) usage; exit 0 ;;
      --dir | --source | --ref | --mode | --lang | --sectors)
        if [ $# -lt 2 ]; then usage_error "$opt needs a value"; fi
        value=$2
        shift 2
        ;;
      *) usage_error "unknown option: $opt" ;;
    esac
    case $opt in
      --dir) MK_DIR=$value; MK_DIR_GIVEN=1 ;;
      --source) MK_SOURCE=$value ;;
      --ref) MK_REF=$value ;;
      --mode) MK_MODE=$value ;;
      --lang) MK_LANG=$value ;;
      --sectors) MK_SECTORS=$value ;;
    esac
  done
  validate_args
}

validate_args() {
  case $MK_MODE in '' | github | local | combined) ;; *) usage_error "--mode must be github, local or combined" ;; esac
  case $MK_LANG in *[!a-z-]*) usage_error "--lang must be a language code such as en or cs" ;; esac
  case $MK_SECTORS in *[!A-Za-z0-9,:_-]*) usage_error "--sectors must be a list such as core,work" ;; esac
  case $MK_REF in -* | *[!A-Za-z0-9._/-]*) usage_error "--ref must be a tag or branch name" ;; esac
  case $MK_SOURCE in -*) usage_error "--source must be a git URL or a folder" ;; esac
  if [ -z "$MK_DIR" ]; then
    if [ -z "${HOME-}" ]; then usage_error "HOME is not set: pass --dir <path>"; fi
    MK_DIR="$HOME/memory"
  fi
  MK_DIR=$(absolute_path "$MK_DIR")
  MK_SOURCE_DEFAULT=0
  if [ -z "$MK_SOURCE" ]; then
    MK_SOURCE=$KIT_URL_DEFAULT
    MK_SOURCE_DEFAULT=1
  fi
}

# An absolute path without a trailing slash; ~ means the home folder.
absolute_path() {
  p=$1
  case $p in
    \~) p=${HOME-} ;;
    \~/*) p="${HOME-}/${p#\~/}" ;;
  esac
  case $p in
    /*) ;;
    *) p="$(pwd)/$p" ;;
  esac
  while [ "$p" != / ] && [ "${p%/}" != "$p" ]; do p=${p%/}; done
  printf '%s' "$p"
}

# ---------------------------------------------------------------------------------------------
# Interactivity: prompts read the terminal even under `curl | sh`, where stdin is the script.

detect_interactive() {
  MK_INTERACTIVE=0
  if [ "$MK_YES" = 1 ] || [ -n "${CI-}" ] || [ ! -t 1 ]; then return 0; fi
  if [ -t 0 ]; then
    MK_INTERACTIVE=1
  elif (: </dev/tty) 2>/dev/null; then
    MK_INTERACTIVE=1
  fi
}

read_answer() {
  answer=''
  if [ -t 0 ]; then
    IFS= read -r answer || answer=''
  else
    IFS= read -r answer </dev/tty || answer=''
  fi
}

# confirm "question" Y|N: 0 for yes. Non-interactive runs take the default.
confirm() {
  if [ "$MK_INTERACTIVE" != 1 ]; then
    [ "$2" = Y ]
    return
  fi
  if [ "$2" = Y ]; then hint='Y/n'; else hint='y/N'; fi
  printf '  %s?%s %s %s[%s]%s ' "$C_ACCENT" "$C_RESET" "$1" "$C_DIM" "$hint" "$C_RESET"
  read_answer
  case $answer in
    '') [ "$2" = Y ] ;;
    y | Y | yes | Yes | YES | a | A | ano | Ano) return 0 ;;
    *) return 1 ;;
  esac
}

ask_dir() {
  if [ "$MK_INTERACTIVE" != 1 ] || [ "$MK_DIR_GIVEN" = 1 ]; then return 0; fi
  printf '  %s?%s Folder for your memory %s[%s]%s ' "$C_ACCENT" "$C_RESET" "$C_DIM" "$(pretty_path "$MK_DIR")" "$C_RESET"
  read_answer
  if [ -n "$answer" ]; then MK_DIR=$(absolute_path "$answer"); fi
}

# ---------------------------------------------------------------------------------------------
# Prerequisites: report, never install.

os_kind() {
  kind=$(uname -s 2>/dev/null || printf 'unknown')
  case $kind in
    Darwin) printf 'macos' ;;
    Linux)
      ids=''
      if [ -r /etc/os-release ]; then
        while IFS='=' read -r key value; do
          case $key in ID | ID_LIKE) ids="$ids $value" ;; esac
        done </etc/os-release
      fi
      case $ids in
        *debian* | *ubuntu*) printf 'debian' ;;
        *fedora* | *rhel* | *centos*) printf 'fedora' ;;
        *) printf 'linux' ;;
      esac
      ;;
    *) printf 'other' ;;
  esac
}

check_git() {
  GIT_STATE=missing
  if ! command -v git >/dev/null 2>&1; then return 0; fi
  # macOS ships /usr/bin/git as a stub that only opens the developer tools installer.
  if [ "$(uname -s 2>/dev/null || true)" = Darwin ] && [ "$(command -v git)" = /usr/bin/git ]; then
    if ! xcode-select -p >/dev/null 2>&1; then return 0; fi
  fi
  GIT_VERSION=$(git --version 2>/dev/null </dev/null) || return 0
  GIT_VERSION=${GIT_VERSION#git version }
  GIT_STATE=ok
}

check_node() {
  NODE_STATE=missing
  NODE_VERSION=''
  if ! command -v node >/dev/null 2>&1; then return 0; fi
  NODE_VERSION=$(node -p 'process.versions.node' 2>/dev/null </dev/null) || NODE_VERSION=''
  case $NODE_VERSION in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) NODE_STATE=broken; return 0 ;;
  esac
  major=${NODE_VERSION%%.*}
  rest=${NODE_VERSION#*.}
  minor=${rest%%.*}
  case $major$minor in *[!0-9]*) NODE_STATE=broken; return 0 ;; esac
  if [ "$major" -lt "$NODE_MIN_MAJOR" ] || { [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -lt "$NODE_MIN_MINOR" ]; }; then
    NODE_STATE=old
  elif [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -lt "$NODE_FAST_MINOR" ]; then
    NODE_STATE=slow
  else
    NODE_STATE=ok
  fi
}

install_advice() {
  os=$(os_kind)
  heading 'Install what is missing, then run the installer again:'
  case $os in
    macos)
      if ! command -v brew >/dev/null 2>&1; then note 'Homebrew first: https://brew.sh'; fi
      if [ "$NODE_STATE" != ok ] && [ "$NODE_STATE" != slow ]; then command_line 'brew install node'; fi
      if [ "$GIT_STATE" != ok ]; then command_line 'xcode-select --install'; fi
      ;;
    debian)
      if [ "$NODE_STATE" != ok ] && [ "$NODE_STATE" != slow ]; then
        note 'Node.js (the apt package is too old on Debian 12/13 and Ubuntu 24.04):'
        command_line 'curl -fsSL https://fnm.vercel.app/install | bash'
        command_line 'fnm install 24'
      fi
      if [ "$GIT_STATE" != ok ]; then command_line 'sudo apt install git'; fi
      ;;
    fedora)
      if [ "$NODE_STATE" != ok ] && [ "$NODE_STATE" != slow ]; then command_line 'sudo dnf install nodejs'; fi
      if [ "$GIT_STATE" != ok ]; then command_line 'sudo dnf install git'; fi
      ;;
    *)
      if [ "$GIT_STATE" != ok ]; then note 'git: install it with your package manager'; fi
      ;;
  esac
  if [ "$os" != debian ] && [ "$NODE_STATE" != ok ] && [ "$NODE_STATE" != slow ]; then
    note 'Node.js on any system, with fnm (no sudo):'
    command_line 'curl -fsSL https://fnm.vercel.app/install | bash'
    command_line 'fnm install 24'
  fi
  line ''
}

check_prerequisites() {
  check_git
  check_node
  if [ "$GIT_STATE" = ok ]; then ok "git $GIT_VERSION"; else fail 'git is missing'; fi
  case $NODE_STATE in
    ok) ok "Node.js $NODE_VERSION" ;;
    slow) warn "Node.js $NODE_VERSION works; search is faster from Node.js $NODE_MIN_MAJOR.$NODE_FAST_MINOR (node:sqlite with FTS5)" ;;
    old) fail "Node.js $NODE_VERSION is too old: memory-kit needs $NODE_MIN_MAJOR.$NODE_MIN_MINOR or newer" ;;
    broken) fail 'node is on PATH but did not report a version' ;;
    *) fail "Node.js is missing: memory-kit needs $NODE_MIN_MAJOR.$NODE_MIN_MINOR or newer" ;;
  esac
  if [ "$GIT_STATE" != ok ] || { [ "$NODE_STATE" != ok ] && [ "$NODE_STATE" != slow ]; }; then
    install_advice
    exit 2
  fi
  if [ -z "${GIT_AUTHOR_EMAIL-}${EMAIL-}$(git config user.email 2>/dev/null </dev/null || true)" ]; then
    warn 'git has no identity yet (needed for the first commit):'
    command_line 'git config --global user.name "Your Name"'
    command_line 'git config --global user.email "you@example.com"'
  fi
}

refuse_sudo() {
  if [ "$(id -u 2>/dev/null || printf 1)" = 0 ] && [ -n "${SUDO_USER-}" ] && ! is_true "${MEMORY_KIT_ALLOW_ROOT-}"; then
    fail 'do not run the installer with sudo: the memory would belong to root. Run it as yourself (MEMORY_KIT_ALLOW_ROOT=1 overrides this).'
    exit 3
  fi
}

# ---------------------------------------------------------------------------------------------
# The target folder

dir_is_empty() {
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ -e "$entry" ] || [ -L "$entry" ]; then return 1; fi
  done
  return 0
}

# DIR_STATE: new (missing or empty), vault (set up), kit (downloaded, setup not finished), other.
inspect_dir() {
  DIR_STATE=other
  if [ ! -e "$MK_DIR" ] && [ ! -L "$MK_DIR" ]; then DIR_STATE=new; return 0; fi
  if [ ! -d "$MK_DIR" ]; then return 0; fi
  if dir_is_empty "$MK_DIR"; then DIR_STATE=new; return 0; fi
  if [ ! -f "$MK_DIR/memory.json" ] || [ ! -f "$MK_DIR/system/memory.mjs" ]; then return 0; fi
  code=0
  node -e 'try { const t = require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, ""); process.exit(JSON.parse(t).initialized === true ? 0 : 1); } catch { process.exit(2); }' "$MK_DIR/memory.json" </dev/null || code=$?
  if [ "$code" = 1 ]; then DIR_STATE=kit; else DIR_STATE=vault; fi
}

# The first remote of a folder that points at the public kit repository, or nothing.
public_kit_remote() {
  if [ ! -e "$1/.git" ]; then return 0; fi
  git -C "$1" remote -v 2>/dev/null </dev/null | while read -r _name url _kind; do
    lower=$(printf '%s' "$url" | tr '[:upper:]' '[:lower:]')
    case $lower in
      *8krystof8/memory-kit | *8krystof8/memory-kit.git | *8krystof8/memory-kit/)
        printf '%s' "$url"
        break
        ;;
    esac
  done
}

refuse_public_remote() {
  remote=$(public_kit_remote "$MK_DIR")
  if [ -n "$remote" ]; then
    fail "$(pretty_path "$MK_DIR") is a clone of the public kit repository ($remote)."
    note 'Personal notes must never be pushed there. Remove that remote, or choose another folder:'
    command_line "git -C $(shell_quote "$MK_DIR") remote remove origin"
    exit 3
  fi
}

# ---------------------------------------------------------------------------------------------
# Getting the kit

is_local_source() { [ -d "$MK_SOURCE" ]; }

source_label() {
  if [ "$MK_SOURCE_DEFAULT" = 1 ]; then
    printf 'github.com/%s' "$KIT_TEMPLATE"
  else
    printf '%s' "$MK_SOURCE"
  fi
}

# The newest vX.Y.Z tag of a git URL, or nothing when it has none. Fails when git cannot reach it.
newest_tag() {
  refs=$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags "$1" </dev/null) || return 1
  printf '%s\n' "$refs" \
    | sed -n 's|^[0-9a-f]*[[:space:]]*refs/tags/\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)$|\1|p' \
    | sort -t . -k 1.2,1n -k 2,2n -k 3,3n \
    | tail -n 1
}

resolve_ref() {
  if [ -n "$MK_REF" ] || is_local_source; then return 0; fi
  if ! tag=$(newest_tag "$MK_SOURCE"); then
    fail "cannot reach $(source_label) (git ls-remote failed). Check the network, or pass --source."
    exit 1
  fi
  MK_REF=$tag
}

# Copies a kit folder without its git data, local state and caches.
copy_kit_folder() {
  mkdir "$2" || return 1
  for entry in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then continue; fi
    case ${entry##*/} in .git | .memory-kit | node_modules | .cache | .trash) continue ;; esac
    cp -R "$entry" "$2/" || return 1
  done
}

# Puts the kit into $1 (a new folder) as a fresh git repository with no remote and no history.
download_kit() {
  dest=$1
  if is_local_source && [ -z "$MK_REF" ]; then
    if [ ! -f "$MK_SOURCE/system/init.mjs" ]; then
      fail "$MK_SOURCE is not a memory-kit folder (system/init.mjs is missing)"
      exit 1
    fi
    if ! copy_kit_folder "$MK_SOURCE" "$dest"; then
      fail "copying $MK_SOURCE failed"
      exit 1
    fi
  else
    set -- -c advice.detachedHead=false clone --quiet --depth 1
    if is_local_source; then set -- "$@" --no-local; fi
    if [ -n "$MK_REF" ]; then set -- "$@" --branch "$MK_REF"; fi
    if ! GIT_TERMINAL_PROMPT=0 git "$@" -- "$MK_SOURCE" "$dest" </dev/null; then
      fail "git clone of $(source_label)${MK_REF:+ at $MK_REF} failed (see above)"
      exit 1
    fi
  fi
  rm -rf "$dest/.git"
  if ! git init --quiet "$dest" </dev/null || ! git -C "$dest" symbolic-ref HEAD refs/heads/main </dev/null; then
    fail "git init in $(pretty_path "$dest") failed"
    exit 1
  fi
}

# gh is usable: installed, logged in, not refused, the default source, and a mode that allows a remote.
gh_available() {
  GH_REASON=''
  if [ "$MK_NO_GH" = 1 ]; then GH_REASON='not used (--no-gh)'; return 1; fi
  if [ "$MK_SOURCE_DEFAULT" != 1 ]; then GH_REASON='not used (--source)'; return 1; fi
  if [ "$MK_MODE" = local ]; then GH_REASON='not used (mode local keeps everything on this computer)'; return 1; fi
  if ! command -v gh >/dev/null 2>&1; then GH_REASON='not installed (optional)'; return 1; fi
  if ! gh auth status >/dev/null 2>&1 </dev/null; then GH_REASON='not logged in (optional: gh auth login)'; return 1; fi
  GH_USER=$(gh api user --jq .login 2>/dev/null </dev/null) || GH_USER=''
  if [ -z "$GH_USER" ]; then GH_REASON='cannot read the GitHub account'; return 1; fi
  GH_NAME=$(printf '%s' "${MK_DIR##*/}" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//; s/-*$//')
  if [ -z "$GH_NAME" ]; then GH_NAME=memory; fi
  return 0
}

# Chooses how the vault is made: USE_GH=1 for a private repository from the template.
choose_method() {
  USE_GH=0
  if ! gh_available; then
    note "GitHub CLI $GH_REASON"
    return 0
  fi
  if [ "$MK_INTERACTIVE" = 1 ]; then
    if confirm "Create the private GitHub repository $GH_USER/$GH_NAME for it?" Y; then USE_GH=1; fi
  elif [ -n "$MK_MODE" ]; then
    USE_GH=1
  fi
  if [ "$USE_GH" = 1 ]; then
    ok "GitHub CLI logged in as $GH_USER"
  else
    note 'GitHub CLI not used: a local repository without a remote'
  fi
}

create_with_gh() {
  if gh repo view "$GH_USER/$GH_NAME" >/dev/null 2>&1 </dev/null; then
    fail "the repository $GH_USER/$GH_NAME exists already. Clone it, or choose another --dir:"
    command_line "gh repo clone $GH_USER/$GH_NAME $(shell_quote "$MK_DIR")"
    exit 1
  fi
  if ! (cd "$1" && gh repo create "$GH_NAME" --template "$KIT_TEMPLATE" --private --clone </dev/null); then
    fail 'gh repo create failed (see above). To make the memory without GitHub, run the installer with --no-gh.'
    exit 1
  fi
  visibility=$(gh repo view "$GH_USER/$GH_NAME" --json visibility --jq .visibility 2>/dev/null </dev/null) || visibility=''
  if [ "$visibility" != PRIVATE ]; then
    fail "$GH_USER/$GH_NAME is not private (${visibility:-unknown}). Make it private on GitHub before you add notes."
    exit 3
  fi
}

create_vault() {
  parent=${MK_DIR%/*}
  if [ -z "$parent" ]; then parent=/; fi
  if ! mkdir -p "$parent"; then
    fail "cannot create $parent"
    exit 1
  fi
  MK_STAGING=$(mktemp -d "$parent/.memory-kit-install.XXXXXX") || {
    fail "cannot create a temporary folder in $parent"
    exit 1
  }
  if [ "$USE_GH" = 1 ]; then
    create_with_gh "$MK_STAGING"
    made="$MK_STAGING/$GH_NAME"
  else
    made="$MK_STAGING/kit"
    download_kit "$made"
  fi
  if [ -d "$MK_DIR" ]; then rmdir "$MK_DIR"; fi
  mv "$made" "$MK_DIR"
  rm -rf "$MK_STAGING"
  MK_STAGING=''
  version=''
  if [ -r "$MK_DIR/system/VERSION" ]; then read -r version <"$MK_DIR/system/VERSION" || true; fi
  if [ "$USE_GH" = 1 ]; then
    ok "memory-kit ${version:-?} in the private repository $GH_USER/$GH_NAME"
  else
    ok "memory-kit ${version:-?} from $(source_label)${MK_REF:+ ($MK_REF)}"
    ok 'fresh git repository, no remote, none of the kit history'
  fi
}

# ---------------------------------------------------------------------------------------------
# Setup (init) and the existing-vault flow

answers_complete() { [ -n "$MK_MODE" ] && [ -n "$MK_LANG" ] && [ -n "$MK_SECTORS" ]; }

finish_hint() {
  command_line "cd $(shell_quote "$MK_DIR")"
  command_line 'node system/init.mjs'
  note 'or with the answers (--mode github, local or combined; --lang en or cs):'
  command_line "node system/init.mjs --mode ${MK_MODE:-github} --lang ${MK_LANG:-en} --sectors ${MK_SECTORS:-core,work} --yes"
}

run_setup() {
  set -- "$MK_DIR/system/init.mjs" --root "$MK_DIR"
  if [ -n "$MK_MODE" ]; then set -- "$@" --mode "$MK_MODE"; fi
  if [ -n "$MK_LANG" ]; then set -- "$@" --lang "$MK_LANG"; fi
  if [ -n "$MK_SECTORS" ]; then set -- "$@" --sectors "$MK_SECTORS"; fi
  if answers_complete; then set -- "$@" --yes; fi
  if [ "$MK_INTERACTIVE" != 1 ] && ! answers_complete; then
    warn 'The kit is in place; the setup needs answers. Finish it with:'
    finish_hint
    line ''
    exit 2
  fi
  note 'setup: node system/init.mjs'
  line ''
  code=0
  if [ "$MK_INTERACTIVE" = 1 ] && [ ! -t 0 ]; then
    node "$@" </dev/tty || code=$?
  elif [ "$MK_INTERACTIVE" = 1 ]; then
    node "$@" || code=$?
  else
    node "$@" </dev/null || code=$?
  fi
  line ''
  if [ "$code" != 0 ]; then
    fail "the setup did not finish (init exit $code). Nothing is lost: run it again:"
    finish_hint
    line ''
    if [ "$code" = 2 ]; then exit 2; fi
    exit 1
  fi
}

summary() {
  ok "Your memory is ready: $(pretty_path "$MK_DIR")"
  heading 'Next'
  command_line "cd $(shell_quote "$MK_DIR")"
  if [ -n "$(git -C "$MK_DIR" status --porcelain 2>/dev/null </dev/null || true)" ]; then
    command_line 'git add -A'
    command_line 'git commit -m "Set up memory"'
  fi
  if [ "$USE_GH" = 1 ]; then command_line 'git push'; fi
  command_line 'node system/memory.mjs doctor'
  command_line 'node system/memory.mjs connect --list'
  note 'connect --list shows your AI apps; node system/memory.mjs connect <app> links one'
  line ''
}

resolve_ref_quietly() {
  if [ -n "$MK_REF" ] || is_local_source; then return 0; fi
  MK_REF=$(newest_tag "$MK_SOURCE" 2>/dev/null) || MK_REF=''
}

# upgrade [--from <source>] [--ref <ref>] [--yes]: the vault's own upgrade, with this run's source.
run_upgrade() {
  set -- "$MK_DIR/system/memory.mjs" upgrade --root "$MK_DIR" "$@"
  if [ "$MK_SOURCE_DEFAULT" != 1 ]; then set -- "$@" --from "$MK_SOURCE"; fi
  if [ -n "$MK_REF" ]; then set -- "$@" --ref "$MK_REF"; fi
  node "$@" </dev/null
}

upgrade_shown() {
  shown='node system/memory.mjs upgrade'
  if [ "$MK_SOURCE_DEFAULT" != 1 ]; then shown="$shown --from $(shell_quote "$MK_SOURCE")"; fi
  if [ -n "$MK_REF" ]; then shown="$shown --ref $MK_REF"; fi
  printf '%s' "$shown"
}

# Reads `upgrade --json` on stdin; prints "current <version>", "available <from> <to>" or "other".
UPGRADE_STATUS_JS='let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
  let r = null;
  try { r = JSON.parse(s.slice(s.indexOf("{"))); } catch { r = null; }
  const res = (r && r.result) || {};
  if (res.up_to_date) console.log("current " + res.installed);
  else if (res.dry_run && r.plan) console.log("available " + r.plan.from + " " + r.plan.to);
  else console.log("other");
});'

vault_flow() {
  version=''
  if [ -r "$MK_DIR/system/VERSION" ]; then read -r version <"$MK_DIR/system/VERSION" || true; fi
  ok "memory-kit ${version:-?} is set up in $(pretty_path "$MK_DIR") already; nothing was downloaded"
  resolve_ref_quietly
  if [ "$MK_INTERACTIVE" != 1 ]; then
    heading 'To check and update it:'
    command_line "cd $(shell_quote "$MK_DIR")"
    command_line 'node system/memory.mjs doctor'
    command_line "$(upgrade_shown)"
    line ''
    return 0
  fi
  if confirm 'Check it with doctor now?' Y; then
    line ''
    node "$MK_DIR/system/memory.mjs" doctor --root "$MK_DIR" </dev/null || true
    line ''
  fi
  note 'looking for a newer memory-kit'
  status=$(run_upgrade --json 2>/dev/null | node -e "$UPGRADE_STATUS_JS" 2>/dev/null) || status=other
  case $status in
    current*)
      ok "memory-kit ${status#current } is up to date"
      ;;
    available*)
      rest=${status#available }
      ok "memory-kit ${rest#* } is available (this memory has ${rest%% *})"
      if confirm 'Upgrade now? A backup comes first; upgrade --rollback undoes it.' Y; then
        line ''
        run_upgrade --yes || true
      fi
      ;;
    *)
      line ''
      run_upgrade || true
      ;;
  esac
  line ''
}

# ---------------------------------------------------------------------------------------------

cleanup() {
  if [ -n "${MK_STAGING-}" ] && [ -d "$MK_STAGING" ]; then rm -rf "$MK_STAGING"; fi
}

main() {
  MK_STAGING=''
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  setup_style
  parse_args "$@"
  header
  refuse_sudo
  detect_interactive
  check_prerequisites
  ask_dir
  inspect_dir
  case $DIR_STATE in
    other)
      fail "$(pretty_path "$MK_DIR") exists and is not a memory-kit folder. Choose another folder with --dir."
      exit 3
      ;;
    vault)
      refuse_public_remote
      vault_flow
      exit 0
      ;;
    kit)
      refuse_public_remote
      USE_GH=0
      ok "memory-kit is downloaded in $(pretty_path "$MK_DIR"); continuing with the setup"
      ;;
    new)
      resolve_ref
      choose_method
      if [ "$MK_INTERACTIVE" = 1 ] && ! confirm "Create the memory in $(pretty_path "$MK_DIR")?" Y; then
        note 'Nothing was changed.'
        exit 130
      fi
      umask 077
      create_vault
      ;;
  esac
  run_setup
  summary
}

main ${1+"$@"}
}
