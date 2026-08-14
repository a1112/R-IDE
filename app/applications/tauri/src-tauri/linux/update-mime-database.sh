#!/bin/sh
set -e

if command -v update-mime-database >/dev/null 2>&1; then
  update-mime-database /usr/share/mime
fi

exit 0
