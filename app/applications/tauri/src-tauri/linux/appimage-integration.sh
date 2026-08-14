#!/bin/sh

set -eu
umask 077

die() {
  printf 'R-IDE AppImage integration: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 2 ] || die 'expected --integrate or --unintegrate and an AppImage path'
action=$1
appimage_path=$2
case "$action" in
  --integrate|--unintegrate) ;;
  *) die 'unsupported action' ;;
esac

case "$appimage_path" in
  /*) ;;
  *) die 'AppImage path must be absolute' ;;
esac
case "$appimage_path" in
  *"
"*|*""*) die 'AppImage path must not contain newlines' ;;
esac
[ ! -L "$appimage_path" ] || die 'AppImage path must not be a symbolic link'
[ -f "$appimage_path" ] || die 'AppImage path must name a regular file'
canonical_appimage=$(readlink -f -- "$appimage_path") || die 'cannot canonicalize AppImage path'
[ "$canonical_appimage" = "$appimage_path" ] || die 'AppImage path must already be canonical'

data_home=${XDG_DATA_HOME:-${HOME:?HOME must be set}/.local/share}
case "$data_home" in
  /*) ;;
  *) die 'XDG_DATA_HOME must be absolute' ;;
esac
case "$data_home" in
  */../*|*/..|*/./*|*/.) die 'XDG_DATA_HOME must not contain path traversal' ;;
esac

if [ -L "$data_home" ]; then
  die 'XDG_DATA_HOME must not be a symbolic link'
fi
mkdir -p -- "$data_home"
canonical_data_home=$(readlink -f -- "$data_home") || die 'cannot canonicalize XDG_DATA_HOME'
[ "$canonical_data_home" = "$data_home" ] || die 'XDG_DATA_HOME must already be canonical and contain no symbolic links'

ensure_directory() {
  directory=$1
  if [ -L "$directory" ]; then
    die "$directory must not be a symbolic link"
  fi
  if [ -e "$directory" ]; then
    [ -d "$directory" ] || die "$directory must be a directory"
  else
    mkdir -- "$directory"
  fi
}

ensure_safe_target() {
  target=$1
  [ ! -L "$target" ] || die "$target must not be a symbolic link"
  if [ -e "$target" ]; then
    [ -f "$target" ] || die "$target must be a regular file"
  fi
}

mime_directory=$data_home/mime
mime_packages_directory=$mime_directory/packages
applications_directory=$data_home/applications
ensure_directory "$mime_directory"
ensure_directory "$mime_packages_directory"
ensure_directory "$applications_directory"

mime_target=$mime_packages_directory/r-ide.xml
desktop_target=$applications_directory/r-ide-appimage.desktop
ensure_safe_target "$mime_target"
ensure_safe_target "$desktop_target"

refresh_caches() {
  if command -v update-mime-database >/dev/null 2>&1; then
    update-mime-database "$mime_directory"
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$applications_directory"
  fi
}

if [ "$action" = '--unintegrate' ]; then
  rm -f -- "$mime_target" "$desktop_target"
  refresh_caches
  exit 0
fi

script_path=$(readlink -f -- "$0") || die 'cannot canonicalize integration helper path'
script_directory=${script_path%/*}
mime_source=$script_directory/r-ide-mime.xml
[ -f "$mime_source" ] || die 'packaged MIME source is missing'
[ ! -L "$mime_source" ] || die 'packaged MIME source must not be a symbolic link'

mime_temporary=
desktop_temporary=
cleanup() {
  if [ -n "$mime_temporary" ]; then
    rm -f -- "$mime_temporary"
  fi
  if [ -n "$desktop_temporary" ]; then
    rm -f -- "$desktop_temporary"
  fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

mime_temporary=$(mktemp "$mime_packages_directory/.r-ide.xml.XXXXXX")
cp -- "$mime_source" "$mime_temporary"
chmod 600 "$mime_temporary"
mv -f -- "$mime_temporary" "$mime_target"
mime_temporary=

escaped_appimage=$(printf '%s' "$canonical_appimage" | sed \
  -e 's/\\/\\\\/g' \
  -e 's/"/\\"/g' \
  -e 's/`/\\`/g' \
  -e 's/\$/\\$/g' \
  -e 's/%/%%/g')
desktop_temporary=$(mktemp "$applications_directory/.r-ide-appimage.desktop.XXXXXX")
cat >"$desktop_temporary" <<EOF
[Desktop Entry]
Categories=Development;
Comment=R-IDE Desktop Application
Exec="$escaped_appimage" %F
StartupWMClass=ride-tauri
Icon=ride-tauri
Name=R-IDE
Terminal=false
Type=Application
MimeType=application/x-shellscript;application/x-fishscript;application/x-bat;application/x-powershell;text/x-csrc;text/x-chdr;text/x-c++src;text/x-c++hdr;text/x-csharp;text/x-go;text/x-java;text/x-kotlin;text/rust;text/x-python;text/x-r-source;text/x-r-ide-r-markdown;text/x-r-ide-quarto;application/sql;text/html;text/css;text/x-scss;text/x-r-ide-less;text/javascript;text/x-r-ide-jsx;application/typescript;text/x-r-ide-typescript-jsx;text/x-r-ide-svelte;text/x-r-ide-vue;application/json;application/x-r-ide-jsonc;application/x-r-ide-workspace;application/xml;application/yaml;application/toml;text/x-r-ide-ini;text/x-r-ide-properties;text/markdown;
EOF
chmod 600 "$desktop_temporary"
mv -f -- "$desktop_temporary" "$desktop_target"
desktop_temporary=

refresh_caches
