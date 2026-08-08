#!/bin/bash
# Give the collector a certificate for localhost, and tell this Mac to trust it.
#
# Why: the game is served over https, and a page served over https may not open
# a plain-http connection — Safari refuses it before the request is made, which
# is the "direct: Load failed" the panel reports. Serving the collector over
# https removes the rule rather than arguing with it.
#
# The certificate is self-signed and covers localhost only. It is added to your
# login keychain, not the system one, so no admin password is needed — macOS will
# ask you to allow the change. Undo it any time with:
#
#   security delete-certificate -c "TronPick Gems collector" ~/Library/Keychains/login.keychain-db
#
set -euo pipefail
cd "$(dirname "$0")"

CERT="cert.pem"
KEY="key.pem"
NAME="TronPick Gems collector"

if [ -f "$CERT" ] && [ -f "$KEY" ]; then
  echo "Certificate already present. Delete $CERT and $KEY to make a new one."
else
  echo "Generating a certificate for localhost"
  openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=$NAME" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -addext "basicConstraints=critical,CA:true" \
    -addext "keyUsage=critical,digitalSignature,keyCertSign" \
    -addext "extendedKeyUsage=serverAuth" 2>/dev/null
  chmod 600 "$KEY"
fi

echo
echo "Adding it to your login keychain as trusted."
echo "macOS will ask for permission — this is that request."
security add-trusted-cert -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$CERT"

echo
echo "Done. Now run:  node server/collect.js"
echo "It will serve https://localhost:8765 and the extension will find it there."
