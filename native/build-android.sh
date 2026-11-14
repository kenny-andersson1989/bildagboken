#!/bin/bash
# Bygger Android-appen (.aab) för Google Play. Används av Codemagic (codemagic.yaml).
# Miljövariabler:
#   ANDROID_KEYSTORE           nyckeln för signering (upload.jks) som base64
#   ANDROID_KEYSTORE_PASSWORD  lösenordet till nyckeln
#   BUILD_NUMBER               ett nummer som ökar för varje bygge
set -euo pipefail
cd "$(dirname "$0")"
miss=""
for v in ANDROID_KEYSTORE ANDROID_KEYSTORE_PASSWORD BUILD_NUMBER; do [ -n "${!v:-}" ] || miss="$miss $v"; done
[ -f android/app/google-services.json ] || miss="$miss google-services.json"
[ -z "$miss" ] || { echo "❌ Saknas:$miss"; exit 1; }

TMP=$(mktemp -d)
printf '%s' "$ANDROID_KEYSTORE" | tr -d ' \r\n' | base64 --decode > "$TMP/upload.jks"
export ANDROID_KEYSTORE_FILE="$TMP/upload.jks"
echo "▶ Nyckelns fingeravtryck (SHA-1 behövs i Firebase för Google-inloggning):"
keytool -list -v -keystore "$ANDROID_KEYSTORE_FILE" -storepass "$ANDROID_KEYSTORE_PASSWORD" | grep -E "SHA1:|SHA256:" || { echo "❌ Fel lösenord eller trasig nyckel (ANDROID_KEYSTORE)"; exit 1; }

echo "▶ Förbereder projektet"
npm ci
npx cap sync android

echo "▶ Bygger"
cd android
chmod +x gradlew
./gradlew --no-daemon bundleRelease
ls -la app/build/outputs/bundle/release/
echo "✅ Klart: app-release.aab (bygge $BUILD_NUMBER). Ladda ner den under Artifacts och ladda upp i Google Play Console."
