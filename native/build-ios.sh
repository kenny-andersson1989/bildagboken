#!/bin/bash
# Bygger iPhone-appen och skickar den till App Store Connect (TestFlight).
# Används av Codemagic (codemagic.yaml), och av GitHub Actions som reserv.
# Miljövariabler:
#   ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY  App Store Connect-nyckeln (Admin): id, issuer och innehållet i .p8-filen
#   APPLE_TEAM_ID                        Team ID
#   CERTIFICATE_PRIVATE_KEY              RSA-nyckel (PEM) för distributionscertifikatet, samma varje gång
#   BUILD_NUMBER                         ett nummer som ökar för varje bygge
set -euo pipefail
cd "$(dirname "$0")"
APP=ios/App
BUNDLE=se.bildagboken.app
miss=""
for v in ASC_KEY_ID ASC_ISSUER_ID ASC_KEY APPLE_TEAM_ID CERTIFICATE_PRIVATE_KEY BUILD_NUMBER; do [ -n "${!v:-}" ] || miss="$miss $v"; done
[ -f "$APP/App/GoogleService-Info.plist" ] || miss="$miss GoogleService-Info.plist"
[ -z "$miss" ] || { echo "❌ Saknas:$miss"; exit 1; }

# En nyckel som klistrats in på en rad får tillbaka sina radbrytningar.
pem() {
  local k; k=$(printf '%s' "$1" | tr -d '\r')
  if [ "$(printf '%s\n' "$k" | wc -l)" -le 1 ]; then
    local head foot body
    head=$(printf '%s' "$k" | grep -o -- '-----BEGIN [A-Z ]*-----')
    foot=$(printf '%s' "$k" | grep -o -- '-----END [A-Z ]*-----')
    body=$(printf '%s' "$k" | sed "s/$head//; s/$foot//" | tr -d ' ')
    k=$(printf '%s\n%s\n%s' "$head" "$(printf '%s' "$body" | fold -w 64)" "$foot")
  fi
  printf '%s\n' "$k"
}
export APP_STORE_CONNECT_KEY_IDENTIFIER="$(printf '%s' "$ASC_KEY_ID" | tr -d ' \r\n')"
export APP_STORE_CONNECT_ISSUER_ID="$(printf '%s' "$ASC_ISSUER_ID" | tr -d ' \r\n')"
export APP_STORE_CONNECT_PRIVATE_KEY="$(pem "$ASC_KEY")"
export CERTIFICATE_PRIVATE_KEY="$(pem "$CERTIFICATE_PRIVATE_KEY")"

X=$(ls -d /Applications/Xcode*.app | sort -V | tail -1)
[ "$(xcode-select -p)" = "$X/Contents/Developer" ] || sudo xcode-select -s "$X" || true
xcodebuild -version
command -v app-store-connect >/dev/null || pip3 install --quiet codemagic-cli-tools

echo "▶ Kontrollerar nyckeln hos Apple"
if ! app-store-connect apps list >/dev/null; then
  echo "❌ Apple godkänner inte nyckeln. Kontrollera att ASC_KEY_ID, ASC_ISSUER_ID och ASC_KEY hör till samma nyckel"
  echo "   under App Store Connect → Användare och åtkomst → Integrationer → Team Keys, och att den har åtkomsten Admin."
  exit 1
fi

echo "▶ Förbereder projektet"
npm ci
npx cap sync ios

echo "▶ Signering"
keychain initialize
app-store-connect fetch-signing-files "$BUNDLE" --type IOS_APP_STORE --create --certificate-key "$CERTIFICATE_PRIVATE_KEY"
keychain add-certificates
xcode-project use-profiles --project "$APP/App.xcodeproj"

echo "▶ Bygger"
REV=$(/usr/libexec/PlistBuddy -c "Print :REVERSED_CLIENT_ID" "$APP/App/GoogleService-Info.plist")
xcode-project build-ipa --project "$APP/App.xcodeproj" --scheme App --config Release \
  --archive-xcargs "DEVELOPMENT_TEAM=$APPLE_TEAM_ID CURRENT_PROJECT_VERSION=$BUILD_NUMBER GOOGLE_REVERSED_CLIENT_ID=$REV"

echo "▶ Skickar till App Store Connect"
app-store-connect publish --path build/ios/ipa/*.ipa
echo "✅ Bygge $BUILD_NUMBER är skickat. Det syns i TestFlight om 5–15 minuter."
