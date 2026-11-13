#!/bin/bash
# Bygger iPhone-appen och skickar den till App Store Connect (TestFlight).
# Används av Codemagic (codemagic.yaml) och GitHub Actions (.github/workflows/ios.yml).
# Kräver miljövariablerna ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY (innehållet i .p8-filen) och APPLE_TEAM_ID,
# och BUILD_NUMBER (ett nummer som ökar för varje bygge).
set -euo pipefail
cd "$(dirname "$0")"
APP=ios/App
miss=""
for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY APPLE_TEAM_ID BUILD_NUMBER; do [ -n "${!v:-}" ] || miss="$miss $v"; done
[ -f "$APP/App/GoogleService-Info.plist" ] || miss="$miss GoogleService-Info.plist"
[ -z "$miss" ] || { echo "Saknas:$miss"; exit 1; }

X=$(ls -d /Applications/Xcode*.app | sort -V | tail -1)
[ "$(xcode-select -p)" = "$X/Contents/Developer" ] || sudo xcode-select -s "$X" || true
xcodebuild -version

npm ci
npx cap sync ios

TMP=$(mktemp -d)
mkdir -p "$TMP/keys"
printf '%s\n' "$ASC_KEY" > "$TMP/keys/AuthKey_$ASC_KEY_ID.p8"
AUTH=(-allowProvisioningUpdates -authenticationKeyPath "$TMP/keys/AuthKey_$ASC_KEY_ID.p8" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID")
REV=$(/usr/libexec/PlistBuddy -c "Print :REVERSED_CLIENT_ID" "$APP/App/GoogleService-Info.plist")

xcodebuild -project "$APP/App.xcodeproj" -scheme App -configuration Release \
  -destination generic/platform=iOS -archivePath "$TMP/App.xcarchive" archive "${AUTH[@]}" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" CURRENT_PROJECT_VERSION="$BUILD_NUMBER" GOOGLE_REVERSED_CLIENT_ID="$REV" \
  | tail -n 80
[ "${PIPESTATUS[0]}" = 0 ]

cat > "$TMP/export.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PLIST
xcodebuild -exportArchive -archivePath "$TMP/App.xcarchive" -exportOptionsPlist "$TMP/export.plist" -exportPath "$TMP/export" "${AUTH[@]}"
echo "Klart: bygge $BUILD_NUMBER är skickat till App Store Connect. Det syns i TestFlight om 5–15 minuter."
