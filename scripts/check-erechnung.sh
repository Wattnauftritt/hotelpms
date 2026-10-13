#!/usr/bin/env bash
# Prueft die Beispielbelege aus scripts/erechnung-beispiele.ts gegen die
# Schematron-Regeln von EN 16931 fuer CII (CEN/TC 434, Validierungsartefakte
# von ConnectingEurope).
#
# Warum: Die Pruefung des Rechnungssystems vom 13.10.2026 hat mit dem
# Validator nachgestellt, dass jede Rechnung mit offenem Betrag nach
# BR-CO-25 abgewiesen wurde -- und in CI lief kein Validator, der es
# gemerkt haette. Ein Beleg, den die Buchhaltung des Kunden zurueckweist,
# faellt sonst erst Wochen spaeter auf.
#
# Was es nicht prueft: die Regeln der XRechnung (BR-DE-*). Die prueft
# `ciiFindings` vor dem Ausstellen; ihr Schematron liegt nicht als
# Release-Datei vor, die sich hier verlaesslich laden liesse.
#
# Aufruf: scripts/check-erechnung.sh   (braucht java, curl, unzip)
set -euo pipefail

CEN_VERSION=1.3.14
SAXON_VERSION=12.5
# Festgehalten, damit ein ausgetauschtes Release nicht still mitlaeuft.
CEN_SHA256=178a28ed56e92354273f2e41803547415dc44431153c509597b2448cfb20d16a
SAXON_SHA256=98c3a91e6e5aaf9b3e2b37601e04b214a6e67098493cdd8232fcb705fddcb674
RESOLVER_SHA256=efc92bd7ed32b3e57095e0b3e872051ccfbbdcc980831ef33e89e38161a85222

arbeit="$(mktemp -d)"
trap 'rm -rf "$arbeit"' EXIT
cd "$(dirname "$0")/.."

# Zwischenablage fuer die drei Downloads; CI legt sie in den Actions-Cache,
# damit nicht jeder Lauf GitHub und Maven Central fragt (beide begrenzen).
ablage="${ERECHNUNG_CACHE:-$HOME/.cache/staygrid-erechnung}"
mkdir -p "$ablage"
laden() {  # datei url sha256
  if [ ! -f "$ablage/$1" ] || ! echo "$3  $ablage/$1" | sha256sum -c --quiet 2>/dev/null; then
    curl -fsSL --retry 4 --retry-delay 5 -o "$ablage/$1" "$2"
  fi
  echo "$3  $ablage/$1" | sha256sum -c --quiet
  cp "$ablage/$1" "$arbeit/$1"
}
laden cen.zip \
  "https://github.com/ConnectingEurope/eInvoicing-EN16931/releases/download/validation-${CEN_VERSION}/en16931-cii-${CEN_VERSION}.zip" \
  "$CEN_SHA256"
laden saxon.jar \
  "https://repo1.maven.org/maven2/net/sf/saxon/Saxon-HE/${SAXON_VERSION}/Saxon-HE-${SAXON_VERSION}.jar" \
  "$SAXON_SHA256"
laden xmlresolver.jar \
  "https://repo1.maven.org/maven2/org/xmlresolver/xmlresolver/5.2.2/xmlresolver-5.2.2.jar" \
  "$RESOLVER_SHA256"
unzip -q "$arbeit/cen.zip" -d "$arbeit/cen"

pnpm exec tsx scripts/erechnung-beispiele.ts "$arbeit/xml"

fehler=0
for beleg in "$arbeit"/xml/*.xml; do
  name="$(basename "$beleg" .xml)"
  java -cp "$arbeit/saxon.jar:$arbeit/xmlresolver.jar" net.sf.saxon.Transform \
    -s:"$beleg" -xsl:"$arbeit/cen/xslt/EN16931-CII-validation.xslt" -o:"$arbeit/$name.svrl"
  # Jede verletzte Regel ist ein failed-assert; flag="warning" ist ein
  # Hinweis, alles andere weist der Empfaenger ab.
  if grep -q 'flag="fatal"' "$arbeit/$name.svrl"; then
    echo "FEHLER $name:"
    # Der Text je Verstoss nennt die Regel in eckigen Klammern.
    tr '\n' ' ' < "$arbeit/$name.svrl" | sed 's#</svrl:failed-assert>#\n#g' \
      | grep 'flag="fatal"' | sed -e 's/.*<svrl:text>//' -e 's/<[^>]*>//g' -e 's/  */ /g' \
      | sed 's/^/  /' | head -20
    fehler=1
  else
    echo "ok     $name"
  fi
done
exit "$fehler"
