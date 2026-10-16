#!/bin/bash
# Enroll Google Chrome on this Mac in Chrome Enterprise Core (free cloud
# management), so Chrome accepts the self-hosted "Google Web Results Only"
# extension without an MDM. Once enrolled, the extension itself is
# force-installed from the Google Admin console (see README).
#
# Run as root, e.g. as a NinjaOne agent script on macOS.
# Pass the enrollment token (Google Admin console > Devices > Chrome >
# Managed browsers > Enrollment tokens) in ONE of these ways:
#   - NinjaOne script variable/environment variable CHROME_ENROLLMENT_TOKEN
#   - first argument:  enroll-chrome-enterprise-core.sh <token>
# Do not commit the token to the repository.
#
#   --remove   delete the token file (Chrome stays enrolled until it is also
#              removed under Managed browsers in the Admin console)

set -euo pipefail

TOKEN_DIR="/Library/Google/Chrome"
TOKEN_FILE="$TOKEN_DIR/CloudManagementEnrollmentToken"

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run this script as root." >&2
  exit 1
fi

if [ "${1:-}" = "--remove" ]; then
  if [ -f "$TOKEN_FILE" ]; then
    rm -f "$TOKEN_FILE"
    echo "Removed $TOKEN_FILE"
  else
    echo "No token file at $TOKEN_FILE. Nothing changed."
  fi
  exit 0
fi

TOKEN="${1:-${CHROME_ENROLLMENT_TOKEN:-}}"
TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
if [ -z "$TOKEN" ]; then
  echo "ERROR: no enrollment token. Set CHROME_ENROLLMENT_TOKEN or pass it as the first argument." >&2
  exit 1
fi
if ! printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9-]{8,}$'; then
  echo "ERROR: the enrollment token has an unexpected format." >&2
  exit 1
fi

if [ -f "$TOKEN_FILE" ] && [ "$(cat "$TOKEN_FILE")" = "$TOKEN" ]; then
  echo "Token already present at $TOKEN_FILE. Nothing changed."
else
  mkdir -p "$TOKEN_DIR"
  # Write without a trailing newline; readable by all users, writable by root only.
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  chown root:wheel "$TOKEN_FILE"
  chmod 644 "$TOKEN_FILE"
  echo "Wrote enrollment token to $TOKEN_FILE"
fi

if [ -d "/Applications/Google Chrome.app" ]; then
  echo "Chrome enrolls the next time it starts. Quit and reopen Chrome (or restart the Mac),"
  echo "then check chrome://management and chrome://policy."
else
  echo "WARNING: Google Chrome is not installed in /Applications. It will enroll on first launch."
fi
