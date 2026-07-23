#!/usr/bin/env bash
# Extrai SHA-256 do keystore para public/.well-known/assetlinks.json
# Uso: ./scripts/extrair-sha256-android.sh [caminho-do-keystore] [alias]
set -euo pipefail
KEYSTORE="${1:-vap-release.jks}"
ALIAS="${2:-vap}"
if [[ ! -f "$KEYSTORE" ]]; then
  echo "Keystore não encontrado: $KEYSTORE"
  echo "Gere primeiro:"
  echo "  keytool -genkey -v -keystore vap-release.jks -alias vap -keyalg RSA -keysize 2048 -validity 10000"
  exit 1
fi
echo "SHA-256 (cole em public/.well-known/assetlinks.json):"
keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" 2>/dev/null | grep -i "SHA256:" | head -1
