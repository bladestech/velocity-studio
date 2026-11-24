#!/usr/bin/env bash
# Velocity Studio - Linux build script.
#
# Detects the distro, CPU architecture and package manager, installs whatever the
# build still needs (asking first), makes sure a recent enough Node.js is available
# (downloads a private, checksum-verified copy if the system one is missing or too old),
# then builds the Linux packages with electron-builder into ./dist.
#
#   bash scripts/build-linux.sh              # AppImage + the distro's native package
#   bash scripts/build-linux.sh --check      # only report what it found / would do
#   bash scripts/build-linux.sh --help       # all options
#
# Test hooks (not for normal use): OS_RELEASE_FILE, VS_UNAME_S, VS_UNAME_M, VS_LIBC.

set -Eeuo pipefail

MIN_NODE_MAJOR=22          # Electron 45 / @electron/rebuild need Node >= 22.12
MIN_NODE_MINOR=12
DEFAULT_NODE_MAJOR=24      # LTS line used for the private copy (armv7l: 22, the last line with official armv7l builds)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TOOLS_DIR="$ROOT/.build-tools"
OS_RELEASE="${OS_RELEASE_FILE:-/etc/os-release}"
[ -r "$OS_RELEASE" ] || OS_RELEASE=/usr/lib/os-release

# ---------------------------------------------------------------- output ----
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  C_B=$'\033[1m'; C_D=$'\033[2m'; C_R=$'\033[31m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_C=$'\033[36m'; C_0=$'\033[0m'
else
  C_B=''; C_D=''; C_R=''; C_G=''; C_Y=''; C_C=''; C_0=''
fi
info() { printf '%s==>%s %s\n' "$C_C" "$C_0" "$*"; }
ok()   { printf '%s ok%s  %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '%serror%s %s\n' "$C_R" "$C_0" "$*" >&2; FINISHED=1; exit 1; } # FINISHED=1: the error is already reported
have() { command -v "$1" >/dev/null 2>&1; }

FINISHED=0
WORK=""
cleanup() {
  local rc=$?
  [ -n "$WORK" ] && rm -rf "$WORK"
  if [ "$FINISHED" != 1 ] && [ "$rc" -ne 0 ]; then
    printf '%sThe build did not finish (exit code %s).%s\n' "$C_R" "$rc" "$C_0" >&2
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: bash scripts/build-linux.sh [options]

Builds Velocity Studio's Linux packages into ./dist.

  -t, --targets LIST   What to build: auto (default), all, or a comma list of
                       appimage,deb,rpm,pacman,tar.gz,dir.
                       auto = AppImage + the package format of this distro
                       (deb on Debian/Ubuntu, rpm on Fedora/RHEL/openSUSE,
                       pacman on Arch; tar.gz elsewhere).
  -a, --arch ARCH      x64, arm64 or armv7l (default: this machine's).
      --check          Only detect and report; install and build nothing.
  -y, --yes            Don't ask before installing system packages.
      --no-install     Never install system packages; fail if something is missing.
      --local-node     Always use a private Node.js in .build-tools/ (leave the system one alone).
      --node-major N   Node.js major version for the private copy (default 24).
      --skip-npm       Don't run npm ci (use the existing node_modules).
  -h, --help           This help.

Environment: NO_COLOR=1 disables colours.
EOF
}

# ------------------------------------------------------------------ args ----
TARGETS_ARG=auto; ARCH_ARG=""; ASSUME_YES=0; NO_INSTALL=0; CHECK_ONLY=0
LOCAL_NODE=0; SKIP_NPM=0; NODE_MAJOR="${VS_NODE_MAJOR:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    -t|--targets)    [ $# -ge 2 ] || die "$1 needs a value"; TARGETS_ARG=$2; shift 2 ;;
    --targets=*)     TARGETS_ARG=${1#*=}; shift ;;
    -a|--arch)       [ $# -ge 2 ] || die "$1 needs a value"; ARCH_ARG=$2; shift 2 ;;
    --arch=*)        ARCH_ARG=${1#*=}; shift ;;
    --node-major)    [ $# -ge 2 ] || die "$1 needs a value"; NODE_MAJOR=$2; shift 2 ;;
    --node-major=*)  NODE_MAJOR=${1#*=}; shift ;;
    -y|--yes)        ASSUME_YES=1; shift ;;
    --no-install)    NO_INSTALL=1; shift ;;
    --local-node)    LOCAL_NODE=1; shift ;;
    --skip-npm)      SKIP_NPM=1; shift ;;
    --check|--doctor) CHECK_ONLY=1; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               usage >&2; die "Unknown option: $1" ;;
  esac
done
case "$NODE_MAJOR" in ''|*[!0-9]*) [ -z "$NODE_MAJOR" ] || die "--node-major must be a number" ;; esac

# ------------------------------------------------------------- detection ----
osr() { # osr KEY: value of KEY from os-release, quotes removed
  [ -r "$OS_RELEASE" ] || return 0
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); gsub(/^["\047]|["\047]$/, ""); print; exit }' "$OS_RELEASE"
}

detect_platform() {
  UNAME_S="${VS_UNAME_S:-$(uname -s)}"
  UNAME_M="${VS_UNAME_M:-$(uname -m)}"
  [ "$UNAME_S" = Linux ] || die "This script builds the Linux packages and has to run on Linux (this is $UNAME_S). On Windows use: npm run dist"
  case "$UNAME_M" in
    x86_64|amd64)    HOST_ARCH=x64 ;;
    aarch64|arm64)   HOST_ARCH=arm64 ;;
    armv7l|armv8l)   HOST_ARCH=armv7l ;;
    *) die "Unsupported CPU: $UNAME_M (Electron has Linux builds for x64, arm64 and armv7l)." ;;
  esac
  ARCH="${ARCH_ARG:-$HOST_ARCH}"
  case "$ARCH" in x64|arm64|armv7l) ;; *) die "--arch must be x64, arm64 or armv7l (got '$ARCH')." ;; esac

  # Electron's Linux binaries (and electron-builder's helper tools) are linked against glibc.
  LIBC=${VS_LIBC:-glibc}
  if [ -z "${VS_LIBC:-}" ] && have ldd; then
    local out; out=$(ldd --version 2>&1 || true)
    case "$out" in *[Mm]usl*) LIBC=musl ;; esac
  fi
}

classify_distro() {
  DISTRO_ID=$(osr ID); DISTRO_LIKE=$(osr ID_LIKE); DISTRO_NAME=$(osr PRETTY_NAME)
  [ -n "$DISTRO_NAME" ] || DISTRO_NAME=${DISTRO_ID:-unknown}
  FAMILY=unknown
  local t
  for t in $DISTRO_ID $DISTRO_LIKE; do
    case "$t" in
      debian|ubuntu|linuxmint|pop|raspbian|kali|elementary|neon|zorin|devuan|mx|parrot|deepin|pureos|tuxedo) FAMILY=debian ;;
      fedora|rhel|centos|rocky|almalinux|ol|amzn|nobara|bazzite|scientific|eurolinux) FAMILY=redhat ;;
      arch|archarm|manjaro|endeavouros|garuda|cachyos|artix|steamos|arcolinux) FAMILY=arch ;;
      suse|opensuse|opensuse-leap|opensuse-tumbleweed|opensuse-slowroll|sles|sled) FAMILY=suse ;;
      alpine) FAMILY=alpine ;;
      void) FAMILY=void ;;
      gentoo|funtoo|calculate) FAMILY=gentoo ;;
      nixos) FAMILY=nix ;;
    esac
    if [ "$FAMILY" != unknown ]; then break; fi
  done
  if [ "$FAMILY" = unknown ]; then # unrecognised derivative: go by the package manager that is installed
    if   have apt-get;      then FAMILY=debian
    elif have dnf || have yum; then FAMILY=redhat
    elif have pacman;       then FAMILY=arch
    elif have zypper;       then FAMILY=suse
    elif have xbps-install; then FAMILY=void
    elif have emerge;       then FAMILY=gentoo
    elif have apk;          then FAMILY=alpine
    fi
  fi

  PM=""
  case "$FAMILY" in
    debian) PM=apt-get ;;
    redhat) if have dnf; then PM=dnf; else PM=yum; fi ;;
    arch)   PM=pacman ;;
    suse)   PM=zypper ;;
    void)   PM=xbps-install ;;
    gentoo) PM=emerge ;;
  esac

  IMMUTABLE=""
  if [ -e /run/ostree-booted ]; then IMMUTABLE="an rpm-ostree / ostree system"; fi

  # Who can install packages?
  SUDO=""; PRIV=none
  if [ "$(id -u)" -eq 0 ]; then PRIV=root
  elif have sudo; then SUDO=sudo; PRIV=sudo
  elif have doas; then SUDO=doas; PRIV=doas
  fi
}

check_supported() {
  if [ "$LIBC" = musl ] || [ "$FAMILY" = alpine ]; then
    die "$DISTRO_NAME uses musl libc, and Electron's Linux binaries need glibc. Build inside a glibc distro instead (for example: distrobox create -i debian:12, or a Debian/Ubuntu container) and copy the packages out."
  fi
  if [ "$FAMILY" = nix ]; then
    if [ ! -e /lib64/ld-linux-x86-64.so.2 ] && [ ! -e /lib/ld-linux-aarch64.so.1 ] && [ ! -e /lib/ld-linux-armhf.so.3 ]; then
      die "NixOS can't run the prebuilt Electron / electron-builder binaries (no FHS dynamic loader). Build inside a regular distro container (distrobox / docker) or enable nix-ld, then re-run."
    fi
  fi
}

# ---------------------------------------------------------------- targets ----
T=()
norm_target() {
  case "${1,,}" in
    appimage)        echo AppImage ;;
    deb)             echo deb ;;
    rpm)             echo rpm ;;
    pacman)          echo pacman ;;
    tar.gz|targz|tgz|tar) echo tar.gz ;;
    dir)             echo dir ;;
    *) die "Unknown target '$1' (use appimage, deb, rpm, pacman, tar.gz or dir)." ;;
  esac
}
resolve_targets() {
  local raw=() t n
  case "$TARGETS_ARG" in
    auto)
      raw=(appimage)
      case "$FAMILY" in
        debian)      raw+=(deb) ;;
        redhat|suse) raw+=(rpm) ;;
        arch)        raw+=(pacman) ;;
        *)           raw+=(tar.gz) ;;
      esac ;;
    all) raw=(appimage deb rpm pacman tar.gz) ;;
    *)   IFS=, read -r -a raw <<<"$TARGETS_ARG" ;;
  esac
  T=()
  for t in "${raw[@]}"; do
    [ -n "$t" ] || continue
    n=$(norm_target "$t")
    case " ${T[*]:-} " in *" $n "*) ;; *) T+=("$n") ;; esac
  done
  [ "${#T[@]}" -gt 0 ] || die "No build targets selected."
}
wants() { case " ${T[*]} " in *" $1 "*) return 0 ;; esac; return 1; }

# ------------------------------------------------------- dependencies ------
pkg_for() { # pkg_for COMMAND -> package that provides it on $FAMILY
  case "$1:$FAMILY" in
    curl:gentoo)                     echo net-misc/curl ;;
    curl:*)                          echo curl ;;
    xz:debian)                       echo xz-utils ;;
    xz:gentoo)                       echo app-arch/xz-utils ;;
    xz:*)                            echo xz ;;
    ar:gentoo)                       echo sys-devel/binutils ;;
    ar:*)                            echo binutils ;;
    rpmbuild:debian|rpmbuild:void)   echo rpm ;;
    rpmbuild:arch)                   echo rpm-tools ;;
    rpmbuild:gentoo)                 echo app-arch/rpm ;;
    rpmbuild:*)                      echo rpm-build ;;
    bsdtar:debian)                   echo libarchive-tools ;;
    bsdtar:arch|bsdtar:void)         echo libarchive ;;
    bsdtar:gentoo)                   echo app-arch/libarchive ;;
    bsdtar:*)                        echo bsdtar ;;
    tar:*|gzip:*)                    echo "$1" ;;
    *)                               echo "" ;;
  esac
}

node_version_ok() {
  have node && have npm || return 1
  local v major minor
  v=$(node -p 'process.versions.node' 2>/dev/null) || return 1
  major=${v%%.*}; minor=${v#*.}; minor=${minor%%.*}
  [ "$major" -gt "$MIN_NODE_MAJOR" ] && return 0
  [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ] && return 0
  return 1
}

NEEDS_FPM=0
MISSING=(); PKGS=""; UNMAPPED=()
plan_dependencies() {
  MISSING=(); PKGS=""; UNMAPPED=()
  local need=(tar gzip) c p
  if wants deb;    then need+=(ar xz); fi
  if wants rpm;    then need+=(rpmbuild); fi
  if wants pacman; then need+=(bsdtar xz); fi
  if [ "$NODE_PLAN" = download ] && ! have curl && ! have wget; then need+=(curl); fi
  for c in "${need[@]}"; do
    have "$c" && continue
    case " ${MISSING[*]:-} " in *" $c "*) continue ;; esac
    MISSING+=("$c")
    p=$(pkg_for "$c")
    if [ -z "$p" ]; then UNMAPPED+=("$c"); continue; fi
    case " $PKGS " in *" $p "*) ;; *) PKGS="${PKGS:+$PKGS }$p" ;; esac
  done
  # electron-builder bundles fpm (deb / rpm / pacman) for x64 hosts only; elsewhere a system fpm is needed.
  NEEDS_FPM=0
  if [ "$HOST_ARCH" != x64 ] && { wants deb || wants rpm || wants pacman; }; then NEEDS_FPM=1; fi
}

as_root() {
  if [ "$PRIV" = root ]; then "$@"
  elif [ -n "$SUDO" ]; then "$SUDO" "$@"
  else die "Need root to run: $* (no sudo or doas found). Run it as root, then re-run this script."
  fi
}
quote() { local a out=""; for a in "$@"; do out+="$(printf '%q' "$a") "; done; printf '%s' "${out% }"; }

install_command_text() { # the command line shown to the user
  local pre=""; [ -n "$SUDO" ] && pre="$SUDO "
  case "$PM" in
    apt-get)      printf '%s' "${pre}apt-get update && ${pre}apt-get install -y $PKGS" ;;
    dnf|yum)      printf '%s' "${pre}$PM install -y $PKGS" ;;
    pacman)       printf '%s' "${pre}pacman -S --needed --noconfirm $PKGS" ;;
    zypper)       printf '%s' "${pre}zypper --non-interactive install --no-recommends $PKGS" ;;
    xbps-install) printf '%s' "${pre}xbps-install -Sy $PKGS" ;;
    emerge)       printf '%s' "${pre}emerge --noreplace $PKGS" ;;
  esac
}
install_packages() {
  local pk; read -r -a pk <<<"$PKGS"
  case "$PM" in
    apt-get)      as_root apt-get update; as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "${pk[@]}" ;;
    dnf|yum)      as_root "$PM" install -y "${pk[@]}" ;;
    pacman)       as_root pacman -S --needed --noconfirm "${pk[@]}" ;;
    zypper)       as_root zypper --non-interactive install --no-recommends "${pk[@]}" ;;
    xbps-install) as_root xbps-install -Sy "${pk[@]}" ;;
    emerge)       as_root emerge --noreplace "${pk[@]}" ;;
  esac
}
confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || return 1
  local a; read -r -p "$1 [Y/n] " a || return 1
  case "${a:-y}" in [Yy]*) return 0 ;; *) return 1 ;; esac
}

ensure_dependencies() {
  [ "${#MISSING[@]}" -gt 0 ] || return 0
  warn "Missing build tools: ${MISSING[*]}"
  [ "$NO_INSTALL" = 0 ] || die "Install them yourself (or drop --no-install), then re-run."
  if [ -n "$IMMUTABLE" ]; then
    die "This is $IMMUTABLE, so the base system can't be changed here. Run the script inside a toolbox / distrobox container (or layer the packages with rpm-ostree: ${PKGS:-${MISSING[*]}})."
  fi
  if [ -z "$PM" ] || ! have "$PM" || [ -z "$PKGS" ] || [ "${#UNMAPPED[@]}" -gt 0 ]; then
    die "Can't install these automatically on $DISTRO_NAME. Install the tools that provide: ${MISSING[*]} - then re-run."
  fi
  info "Will run: $(install_command_text)"
  confirm "Install ${PKGS} now?" || die "Not installing. Install: $PKGS - then re-run (or pass --yes)."
  install_packages
  local c
  for c in "${MISSING[@]}"; do have "$c" || die "'$c' is still missing after installing packages."; done
  ok "Build tools installed"
}

# -------------------------------------------------------------------- node ----
download() { # download URL DEST
  if have curl; then curl -fsSL --retry 3 -o "$2" "$1"
  elif have wget; then wget -q -O "$2" "$1"
  else die "Need curl or wget to download Node.js."
  fi
}
sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  elif have openssl; then openssl dgst -sha256 "$1" | awk '{print $NF}'
  else die "Need sha256sum, shasum or openssl to verify the Node.js download."
  fi
}

plan_node() {
  NODE_PLAN=system
  if [ "$LOCAL_NODE" = 1 ] || ! node_version_ok; then NODE_PLAN=download; fi
  if [ -z "$NODE_MAJOR" ]; then
    if [ "$HOST_ARCH" = armv7l ]; then NODE_MAJOR=22; else NODE_MAJOR=$DEFAULT_NODE_MAJOR; fi
  fi
}

ensure_node() {
  if [ "$NODE_PLAN" = system ]; then ok "Using system Node.js $(node -v) / npm $(npm -v)"; return 0; fi
  local base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x" sums line file sha dir
  WORK=${WORK:-$(mktemp -d)}
  mkdir -p "$TOOLS_DIR"
  info "Looking up the latest Node.js ${NODE_MAJOR}.x for linux-${HOST_ARCH}"
  sums="$WORK/SHASUMS256.txt"
  download "$base/SHASUMS256.txt" "$sums"
  line=$(awk -v suf="-linux-${HOST_ARCH}.tar.gz" 'index($2, "node-v") == 1 && substr($2, length($2) - length(suf) + 1) == suf { print; exit }' "$sums")
  [ -n "$line" ] || die "No official Node.js ${NODE_MAJOR}.x build for linux-${HOST_ARCH}. Install Node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} yourself, or try --node-major."
  sha=${line%% *}; file=${line##* }; dir="$TOOLS_DIR/${file%.tar.gz}"
  if [ ! -x "$dir/bin/node" ]; then
    info "Downloading $file"
    download "$base/$file" "$WORK/$file"
    [ "$(sha256_of "$WORK/$file")" = "$sha" ] || die "Checksum mismatch for $file - refusing to use it."
    tar -xzf "$WORK/$file" -C "$TOOLS_DIR"
    [ -x "$dir/bin/node" ] || die "Unpacking $file did not produce $dir/bin/node."
  fi
  export PATH="$dir/bin:$PATH"
  hash -r
  node_version_ok || die "The downloaded Node.js doesn't run here ($dir/bin/node)."
  ok "Using private Node.js $(node -v) from ${dir#"$ROOT"/}"
}

ensure_fpm() {
  [ "$NEEDS_FPM" = 1 ] || return 0
  if ! have fpm && have gem; then
    info "Installing fpm with gem (needed to build deb/rpm/pacman on $HOST_ARCH)"
    gem install --user-install --no-document fpm || warn "gem install fpm failed"
    local gd; gd=$(ruby -e 'print Gem.user_dir' 2>/dev/null || true)
    [ -z "$gd" ] || export PATH="$gd/bin:$PATH"
  fi
  if have fpm; then
    export USE_SYSTEM_FPM=true
    return 0
  fi
  local keep=() t
  for t in "${T[@]}"; do case "$t" in deb|rpm|pacman) ;; *) keep+=("$t") ;; esac; done
  if [ "${#keep[@]}" -eq 0 ] || [ "$TARGETS_ARG" != auto ]; then
    die "Building deb/rpm/pacman on $HOST_ARCH needs a system fpm (gem install fpm; needs ruby, a C compiler and make). Install it or choose --targets appimage,tar.gz."
  fi
  warn "fpm is not installed, so only ${keep[*]} will be built on $HOST_ARCH (install fpm for deb/rpm/pacman)."
  T=("${keep[@]}")
}

# ------------------------------------------------------------------ report ----
report() {
  printf '\n%sVelocity Studio - Linux build%s\n' "$C_B" "$C_0"
  printf '  %-12s %s %s(id=%s, family=%s)%s\n' "Distro" "$DISTRO_NAME" "$C_D" "${DISTRO_ID:-?}" "$FAMILY" "$C_0"
  printf '  %-12s %s %s(%s)%s%s\n' "CPU" "$ARCH" "$C_D" "$UNAME_M" "$C_0" "$([ "$ARCH" != "$HOST_ARCH" ] && printf ' - cross-build from %s' "$HOST_ARCH")"
  printf '  %-12s %s\n' "libc" "$LIBC"
  printf '  %-12s %s\n' "Pkg manager" "${PM:-none found}"
  printf '  %-12s %s\n' "Privileges" "$PRIV"
  [ -z "$IMMUTABLE" ] || printf '  %-12s %s\n' "Note" "$IMMUTABLE"
  printf '  %-12s %s\n' "Targets" "${T[*]}"
  if [ "$NODE_PLAN" = system ]; then
    printf '  %-12s system %s\n' "Node.js" "$(node -v)"
  elif have node; then
    printf '  %-12s system %s is %s - will download a private Node.js %s.x\n' "Node.js" "$(node -v)" "$([ "$LOCAL_NODE" = 1 ] && echo 'not used (--local-node)' || echo 'too old')" "$NODE_MAJOR"
  else
    printf '  %-12s none - will download a private Node.js %s.x\n' "Node.js" "$NODE_MAJOR"
  fi
  if [ "${#MISSING[@]}" -gt 0 ]; then
    printf '  %-12s %s\n' "Missing" "${MISSING[*]}"
    if [ -n "$PKGS" ] && [ -n "$PM" ] && [ "${#UNMAPPED[@]}" -eq 0 ]; then
      printf '  %-12s %s\n' "Would run" "$(install_command_text)"
    fi
  else
    printf '  %-12s everything needed is installed\n' "Missing"
  fi
  [ "$NEEDS_FPM" != 1 ] || printf '  %-12s %s host: electron-builder needs a system fpm for deb/rpm/pacman\n' "fpm" "$HOST_ARCH"
  printf '\n'
}

ffmpeg_hint() {
  case "$FAMILY" in
    debian) echo "sudo apt install ffmpeg" ;;
    redhat) echo "sudo dnf install ffmpeg-free   (or ffmpeg from RPM Fusion)" ;;
    arch)   echo "sudo pacman -S ffmpeg" ;;
    suse)   echo "sudo zypper install ffmpeg   (from the Packman repository)" ;;
    void)   echo "sudo xbps-install ffmpeg" ;;
    gentoo) echo "sudo emerge media-video/ffmpeg" ;;
    *)      echo "install ffmpeg with your package manager" ;;
  esac
}

# ------------------------------------------------------------------- build ----
build() {
  cd "$ROOT"
  [ -f package.json ] || die "package.json not found in $ROOT"
  if [ "$SKIP_NPM" = 0 ]; then
    if [ ! -x node_modules/.bin/electron-builder ] || [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
      info "Installing npm dependencies"
      if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
    else
      ok "npm dependencies are up to date"
    fi
  fi
  [ -x node_modules/.bin/electron-builder ] || die "node_modules/.bin/electron-builder is missing - run without --skip-npm."

  local marker; WORK=${WORK:-$(mktemp -d)}; marker="$WORK/build-start"; : >"$marker"
  info "Building: ${T[*]} (linux-$ARCH)"
  ./node_modules/.bin/electron-builder --linux "${T[@]}" "--$ARCH" --publish never

  local f found=() size
  while IFS= read -r f; do found+=("$f"); done < <(find dist -maxdepth 1 -type f -newer "$marker" \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' -o -name '*.pacman' -o -name '*.pkg.tar*' -o -name '*.tar.gz' \) | sort)
  [ "${#found[@]}" -gt 0 ] || die "electron-builder finished but produced no packages in dist/."

  printf '\n%sBuilt:%s\n' "$C_B" "$C_0"
  for f in "${found[@]}"; do
    size=$(du -h "$f" | awk '{print $1}')
    printf '  %s  %s(%s)%s\n' "$ROOT/$f" "$C_D" "$size" "$C_0"
  done
  printf '\n%sInstall:%s\n' "$C_B" "$C_0"
  for f in "${found[@]}"; do
    case "$f" in
      *.AppImage)  printf '  chmod +x %q && ./%q          # needs libfuse2, or add --appimage-extract-and-run\n' "$f" "$f" ;;
      *.deb)       printf '  sudo apt install ./%q\n' "$f" ;;
      *.rpm)       printf '  sudo dnf install ./%q     # openSUSE: sudo zypper install ./%q\n' "$f" "$f" ;;
      *.pacman|*.pkg.tar*) printf '  sudo pacman -U ./%q\n' "$f" ;;
      *.tar.gz)    printf '  tar -xzf %q && ./velocity-studio-*/velocity-studio\n' "$f" ;;
    esac
  done
  printf '\n%sffmpeg:%s Velocity Studio uses the ffmpeg installed on the system for GPU (NVENC) and x264/x265 encoding:\n  %s\n\n' "$C_B" "$C_0" "$(ffmpeg_hint)"
}

# -------------------------------------------------------------------- main ----
detect_platform
classify_distro
check_supported
resolve_targets
plan_node
plan_dependencies
report

if [ "$CHECK_ONLY" = 1 ]; then FINISHED=1; exit 0; fi

ensure_dependencies
ensure_node
ensure_fpm
build
FINISHED=1
