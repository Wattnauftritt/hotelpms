#!/usr/bin/env python3
"""Baut apps/api/src/platform/kennwortliste.daten.ts aus Listen geleakter Kennwoerter.

Aufruf: scripts/kennwortliste-bauen.py <liste.txt> [<liste.txt> ...]

Quelle der eingecheckten Fassung (24.10.2026), alle aus SecLists (MIT,
github.com/danielmiessler/SecLists, Passwords/Common-Credentials/):
  100k-most-used-passwords-NCSC.txt, Pwdb_top-1000000.txt,
  xato-net-10-million-passwords-1000000.txt

Aufgenommen wird nur, was mindestens KENNWORT_MIN (12) Zeichen hat: kuerzere
weist schon die Laengenregel ab. Kleingeschrieben, wie die Pruefung in
kennwortliste.ts. Das Filter muss Bit fuer Bit dasselbe rechnen wie dort.
"""
import base64, hashlib, math, sys, unicodedata

MIN = 12
FEHLER = 0.001

def norm(s):
    return unicodedata.normalize('NFKC', s).lower()

eintraege = set()
for pfad in sys.argv[1:]:
    with open(pfad, encoding='utf-8', errors='ignore') as f:
        for zeile in f:
            w = norm(zeile.rstrip('\r\n'))
            if len(w) >= MIN:
                eintraege.add(w)

n = len(eintraege)
m = math.ceil(-n * math.log(FEHLER) / math.log(2) ** 2)
m = (m + 7) // 8 * 8
k = round(m / n * math.log(2))
bits = bytearray(m // 8)
for w in eintraege:
    h = hashlib.sha256(w.encode('utf-8')).digest()
    h1 = int.from_bytes(h[0:4], 'big')
    h2 = int.from_bytes(h[4:8], 'big') | 1
    for i in range(k):
        j = (h1 + i * h2) % m
        bits[j >> 3] |= 1 << (j & 7)

b64 = base64.b64encode(bytes(bits)).decode()
zeilen = [b64[i:i + 100] for i in range(0, len(b64), 100)]
out = 'apps/api/src/platform/kennwortliste.daten.ts'
with open(out, 'w') as f:
    f.write('// Erzeugt von scripts/kennwortliste-bauen.py, nicht von Hand aendern.\n')
    f.write(f'// {n} Eintraege, {m} Bit, {k} Hashfunktionen, Fehlerrate {FEHLER}.\n')
    f.write(f'export const BITS = {m}\nexport const HASHES = {k}\n')
    f.write('export const FILTER = [\n')
    f.write(',\n'.join(f"  '{z}'" for z in zeilen))
    f.write("\n].join('')\n")
print(out, n, m, k)
