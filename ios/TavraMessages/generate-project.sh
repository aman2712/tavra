#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOCAL_CONFIG="$SCRIPT_DIR/Config/Local.xcconfig"

if [ ! -f "$LOCAL_CONFIG" ]; then
  echo "Missing $LOCAL_CONFIG" >&2
  echo "Copy Config/Local.xcconfig.example to Config/Local.xcconfig and replace every placeholder." >&2
  exit 1
fi

if grep -Eq 'yourcompany|your-public|A1B2C3D4E5|tavra\.example|com\.example' "$LOCAL_CONFIG"; then
  echo "Local.xcconfig still contains a placeholder. Add the registered bundle IDs, Apple team ID, and exact Tavra host." >&2
  exit 1
fi

if ! grep -Eq '^TAVRA_DEVELOPMENT_TEAM[[:space:]]*=[[:space:]]*[A-Za-z0-9]{10}[[:space:]]*$' "$LOCAL_CONFIG"; then
  echo "TAVRA_DEVELOPMENT_TEAM must be a 10-character Apple team ID." >&2
  exit 1
fi

if ! grep -Eq '^TAVRA_APP_BUNDLE_ID[[:space:]]*=[[:space:]]*[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+[[:space:]]*$' "$LOCAL_CONFIG"; then
  echo "Both Tavra bundle IDs must be reverse-DNS identifiers." >&2
  exit 1
fi

if ! grep -Eq '^TAVRA_MESSAGES_BUNDLE_ID[[:space:]]*=[[:space:]]*[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9.-]+[[:space:]]*$' "$LOCAL_CONFIG"; then
  echo "Both Tavra bundle IDs must be reverse-DNS identifiers." >&2
  exit 1
fi

if ! grep -Eq '^TAVRA_CHECKOUT_HOST[[:space:]]*=[[:space:]]*[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?[[:space:]]*$' "$LOCAL_CONFIG"; then
  echo "TAVRA_CHECKOUT_HOST must be one exact hostname without a scheme, port, path, or wildcard." >&2
  exit 1
fi

if ! command -v xcodegen >/dev/null 2>&1; then
  echo "xcodegen is required. Install it with: brew install xcodegen" >&2
  exit 1
fi

cd "$SCRIPT_DIR"
xcodegen generate --spec project.yml
echo "Generated $SCRIPT_DIR/TavraMessages.xcodeproj"
