# Benutzerrollen und Berechtigungen

Rollenmodell für zwei Nutzergruppen: **uns** als Betreiber der Plattform und **die Hotels** als Kunden. Ergänzt AP 1 in [11-umsetzungsplan.md](11-umsetzungsplan.md) und die Authentifizierung in [10-systemarchitektur.md](10-systemarchitektur.md).

---

## 1. Grundsätze

1. **Ein Berechtigungskatalog für alle.** Menschen, Maschinen und unsere eigenen Mitarbeitenden prüfen gegen dieselben Berechtigungsschlüssel. OAuth-Scopes sind dieselben Schlüssel. Es gibt keinen zweiten Rechteweg.
2. **Rollen sind benannte Mengen von Berechtigungen.** Der Code prüft nie „ist Rezeption", sondern immer „darf `folio:post`". Rollen sind Konfiguration, Berechtigungen sind Code.
3. **Drei Ebenen:** Plattform, Account, Property. Eine Rolle gilt auf genau einer Ebene. Account-Rollen wirken auf alle Properties des Accounts.
4. **Wir sehen keine Kundendaten ohne ausdrückliche, befristete, protokollierte Freigabe.** Das ist nicht Höflichkeit, sondern Auftragsverarbeitung nach Art. 28 DSGVO: Wir handeln nur auf Weisung. Technisch durchgesetzt über Row Level Security, nicht über Disziplin.
5. **Buchen und Stornieren sind getrennte Rechte.** Der klassische Betrugsweg an einer Rezeption ist buchen, kassieren, stornieren. Wer bucht, storniert nicht ohne Weiteres.
6. **Sensible Gästedaten sind ein eigenes Recht.** Ausweisnummer, Geburtsdatum und Staatsangehörigkeit sieht nur, wer sie für den Meldeschein braucht. Housekeeping und Revenue nie.
7. **Jede Handlung trägt eine Person.** Auch an geteilten Arbeitsplätzen. Das ist die GoBD-Anforderung „wer hat gebucht", und sie scheitert in der Praxis am gemeinsamen Rezeptionslogin.

---

## 2. Die drei Ebenen

```
Plattform (wir)
  └─ Account (unser Kunde, eine juristische Person)
       ├─ Property A (ein Hotel)
       ├─ Property B
       └─ Property C
```

| Ebene | Wer dort Rollen hat | Beispiel |
|---|---|---|
| **Plattform** | Nur unsere Mitarbeitenden | Support sieht Konfiguration und Protokolle, nie Gästedaten |
| **Account** | Zentrale einer Kette, Inhaber | Regionalleitung sieht alle Häuser, verwaltet Nutzer überall |
| **Property** | Personal eines Hauses | Rezeption in Haus A hat in Haus B keine Rechte |

Ein Nutzer kann mehrere Rollen auf mehreren Ebenen haben. Die wirksamen Berechtigungen für eine Anfrage sind die **Vereinigung** aus Account-Rollen und der Property-Rolle für die angesprochene Property.

---

## 3. Berechtigungskatalog

Fester Katalog, im Code definiert, nicht vom Kunden änderbar. Rund 40 Schlüssel, gruppiert. Auszug der tragenden:

| Gruppe | Schlüssel | Bedeutung |
|---|---|---|
| Reservierung | `reservation:read` | Zimmerplan, Listen, Details |
| | `reservation:write` | Anlegen, ändern, stornieren vor Anreise |
| | `reservation:checkin` | Check-in und Check-out ausführen |
| | `reservation:override_restriction` | Restriktionen und Ausbuchung übergehen |
| Gäste | `guest:read` | Name, Kontakt, Historie |
| | `guest:write` | Anlegen, ändern, zusammenführen |
| | `guest:read_identity` | Ausweisdaten, Geburtsdatum, Staatsangehörigkeit |
| | `guest:export` | DSGVO-Auskunft, Löschung anstoßen |
| Folio | `folio:read` | Konten und Positionen sehen |
| | `folio:post` | Leistungen buchen, Zahlungsvermerke erfassen |
| | `folio:void_own` | Eigene Buchungen innerhalb der Frist stornieren |
| | `folio:void_any` | Beliebige Buchungen stornieren |
| | `folio:discount` | Rabatt bis zur konfigurierten Grenze |
| | `folio:discount_unlimited` | Rabatt ohne Grenze |
| | `folio:route` | Umleitungen und Split Billing |
| Rechnung | `invoice:issue` | Rechnung festschreiben |
| | `invoice:credit` | Gutschrift, Storno einer Rechnung |
| Raten | `rate:read` | Preise und Restriktionen sehen |
| | `rate:write` | Preise, Restriktionen, Ratenpläne pflegen |
| Inventar | `inventory:write` | Kategorien, Zimmer, Sperrungen |
| Housekeeping | `housekeeping:read` | Zimmerstatus und Aufgaben |
| | `housekeeping:write` | Status setzen, Aufgaben erledigen |
| | `maintenance:write` | Wartungstickets, Out of Order |
| Berichte | `report:operational` | Anreise, Abreise, Hausliste, Offene Posten |
| | `report:revenue` | Umsatz, ADR, RevPAR, Pickup |
| | `report:export` | DATEV, GoBD, Statistik |
| Nachtlauf | `nightaudit:run` | Manuell auslösen, Prüfliste bearbeiten |
| Einstellungen | `settings:property` | Steuern, Zeiten, Vorlagen, Zahlarten |
| | `settings:account` | Accountweite Einstellungen, Properties anlegen |
| | `user:manage` | Nutzer einladen, Rollen zuweisen |
| | `integration:manage` | API-Clients, Webhooks, Channel Manager |
| Plattform | `platform:accounts` | Accounts anlegen, sperren |
| | `platform:support_session` | Support-Sitzung anfragen |
| | `platform:billing` | Abonnements und unsere Rechnungen an Kunden |

**Konvention:** `ressource:handlung`. Lesen und Schreiben sind stets getrennt. Handlungen mit erhöhtem Risiko haben eigene Schlüssel statt eines allgemeinen `write`.

---

## 4. Systemrollen für Hotels

Von uns definiert, unveränderlich, für alle Kunden gleich. Ein kleines Haus nutzt drei davon, ein großes alle.

| Rolle | Ebene | Darf | Darf nicht | Typische Person |
|---|---|---|---|---|
| **Inhaber** | Account | Alles im Account, Vertrag mit uns, Account löschen, Properties anlegen | Nichts ausgenommen | Eigentümer, Geschäftsführung |
| **Account-Admin** | Account | Nutzer überall verwalten, Einstellungen, alle Berichte aller Häuser | Vertrag, Account löschen | Zentrale einer Kette |
| **Hoteldirektion** | Property | Alles in der Property inklusive Stornos, Rabatte ohne Grenze, Einstellungen, Nutzer, alle Berichte | Accountweite Einstellungen | Direktor, Betriebsleitung |
| **Empfangsleitung** | Property | Wie Rezeption, zusätzlich Stornos fremder Buchungen, Rabatte ohne Grenze, Gutschriften, Restriktionen übergehen, Nachtlauf, Umsatzberichte | Einstellungen, Nutzerverwaltung, Ratenpläne | Front Office Manager |
| **Rezeption** | Property | Reservierungen, Check-in und Check-out, Gäste inklusive Ausweisdaten, Buchen, eigene Stornos in der Frist, Rabatt bis Grenze, Rechnung stellen, operative Listen | Fremde Stornos, Gutschriften, Raten, Umsatzberichte, Einstellungen | Rezeptionist |
| **Reservierung** | Property | Reservierungen und Gäste, Verfügbarkeit, Angebote | Check-in, Folio, Ausweisdaten, Berichte | Reservierungsabteilung größerer Häuser |
| **Nachtdienst** | Property | Wie Rezeption, zusätzlich Nachtlauf und Prüfliste | Wie Rezeption | Nachtportier, Night Auditor |
| **Buchhaltung** | Property oder Account | Folios und Rechnungen lesen, Gutschriften, Umsatzberichte, alle Exporte, Offene Posten | Reservierungen ändern, buchen, Ausweisdaten | Interne Buchhaltung |
| **Steuerberatung** | Property oder Account | Rechnungen lesen, DATEV- und GoBD-Export | Alles andere, keine Gästedaten außer Rechnungsempfänger | Externer Steuerberater |
| **Revenue** | Property oder Account | Raten, Restriktionen, Verfügbarkeit, Umsatzberichte | Gästedaten, Folios, Buchen | Revenue Manager |
| **Housekeeping** | Property | Zimmerstatus setzen, Aufgaben, Wartungstickets, Zimmerliste mit Belegung und Anzahl Personen | Gastnamen über die Zimmerliste hinaus, Reservierungen, Folios | Hausdame, Reinigungskraft |
| **Haustechnik** | Property | Wartungstickets, Out of Order, Zimmerstatus lesen | Alles andere | Techniker |
| **Nur lesen** | Property oder Account | Operative und Umsatzberichte | Jede Änderung | Eigentümer ohne operative Rolle, Controlling |

**Für das Pilothaus reichen vier:** Hoteldirektion, Rezeption, Housekeeping, Steuerberatung.

**Eigene Rollen** aus dem Katalog kann ein Account ab Stufe 3 definieren. Bis dahin genügen die Systemrollen. Erfahrungsgemäß werden eigene Rollen fast ausschließlich für Abweichungen bei Storno- und Rabattrechten gebraucht, und die sind über die beiden Grenzwerte unten bereits konfigurierbar.

### Zwei konfigurierbare Grenzwerte je Property

| Einstellung | Standard | Wirkung |
|---|---|---|
| `void_own_window_minutes` | 15 | Wie lange die Rezeption eine eigene Buchung ohne Empfangsleitung stornieren darf. Deckt Tippfehler ab, nicht mehr |
| `discount_limit_percent` | 10 | Bis zu welchem Prozentsatz die Rezeption ohne Freigabe rabattieren darf |

Beide greifen nur für Rollen mit `folio:void_own` beziehungsweise `folio:discount`. Rollen mit `_any` und `_unlimited` sind davon unberührt.

---

## 5. Systemrollen für uns

Unsere Mitarbeitenden sind Nutzer in derselben Tabelle mit `is_platform_staff = true`, aber ihre Rollen liegen auf Plattformebene und **berühren keine Kundendaten**.

| Rolle | Darf | Darf nicht |
|---|---|---|
| **Plattform-Admin** | Accounts anlegen und sperren, Abonnements, Systemeinstellungen, Support-Sitzungen anfragen, Betriebsüberwachung | Kundendaten ohne aktive Support-Sitzung |
| **Support** | Konfiguration eines Accounts lesen, Protokolle und Fehler sehen, Support-Sitzung anfragen | Kundendaten ohne aktive Support-Sitzung, Accounts sperren |
| **Abrechnung** | Abonnements, Nutzung, unsere Rechnungen an Kunden | Kundendaten, Konfiguration |
| **Betrieb** | Monitoring, Metriken, Alarme | Jeder Zugriff auf Fachdaten |

### Die Support-Sitzung

Der einzige Weg, auf dem wir Kundendaten sehen. Kein anderer existiert, auch nicht für den Plattform-Admin.

1. Ein Support-Mitarbeiter fragt eine Sitzung für einen Account an, mit Grund und Dauer, höchstens 24 Stunden.
2. **Inhaber oder Account-Admin des Kunden gibt sie frei.** Ohne Freigabe passiert nichts. Der Kunde kann jederzeit widerrufen.
3. Während der Sitzung setzt die Anwendung den Mandantenkontext des Support-Mitarbeiters auf die Properties dieses Accounts. Erst dadurch liefert Row Level Security überhaupt Zeilen.
4. Jede Handlung trägt zusätzlich `support_session_id` im Audit-Log. Der Kunde sieht im Nachhinein jede einzelne.
5. Nach Ablauf oder Widerruf ist der Kontext wieder leer.

Ein Notfallzugriff ohne Freigabe, etwa zur Datenrettung, braucht zwei Plattform-Admins gemeinsam, wird sofort protokolliert und dem Inhaber innerhalb von 24 Stunden gemeldet. Das ist die einzige Ausnahme, und sie ist absichtlich unbequem.

---

## 6. Besondere Mechaniken

### Geteilte Arbeitsplätze und Tablets

Rezeptions-PCs werden geteilt, Housekeeping arbeitet an einem gemeinsamen Tablet. Ein gemeinsamer Login macht das Audit-Log wertlos.

- **Arbeitsplatz-Anmeldung plus persönliche PIN.** Der Arbeitsplatz ist einmal am Tag angemeldet, jede Person identifiziert sich vor einer schreibenden Handlung mit ihrer vierstelligen PIN. Die PIN wechselt den aktiven Nutzer für die Sitzung, ohne Neuanmeldung.
- Automatische Rückkehr in den anonymen Zustand nach zwei Minuten ohne Eingabe.
- Lesen ohne PIN ist erlaubt, damit der Zimmerplan an der Wand hängen kann.

Das ist derselbe Mechanismus, den Restaurantkassen seit Jahrzehnten nutzen, und der einzige, der an einer Rezeption tatsächlich befolgt wird.

### Zwei-Faktor-Anmeldung

Pflicht für Inhaber, Account-Admin, Hoteldirektion, Buchhaltung, Steuerberatung und alle Plattformrollen. Optional für die übrigen. TOTP, keine SMS.

### Externe Steuerberatung

Ein häufiger und bisher übersehener Fall. Der Steuerberater ist kein Mitarbeiter, hat aber regelmäßig Zugriffsbedarf auf genau zwei Dinge: Rechnungen und Exporte. Die Rolle ist bewusst eng, damit ein Kanzleimitarbeiter mit schwachem Passwort nicht zum Einfallstor für Gästedaten wird.

### Maschinen

Channel Manager, Buchungsmaschine, Kiosk und Kasse sind keine Nutzer, sondern **OAuth-Clients** mit Scopes aus demselben Katalog, angelegt von jemandem mit `integration:manage`, eingeschränkt auf bestimmte Properties. Ein Kiosk bekommt `reservation:read`, `reservation:checkin`, `guest:write`, `guest:read_identity` und sonst nichts.

### Einladung statt Anlage

Wir legen keine Nutzer für Kunden an. Jemand mit `user:manage` lädt per E-Mail ein, die Person setzt Passwort und gegebenenfalls TOTP selbst. Der Inhaber des ersten Accounts wird beim Vertragsschluss eingeladen.

---

## 7. Datenmodell

```sql
CREATE TABLE permission (
  key         text PRIMARY KEY,          -- 'folio:post'
  description text NOT NULL
);

CREATE TABLE role (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id  bigint,                    -- NULL = Systemrolle
  level       text NOT NULL,             -- platform, account, property
  name        text NOT NULL,
  is_system   boolean NOT NULL DEFAULT false
);

CREATE TABLE role_permission (
  role_id        bigint REFERENCES role(id),
  permission_key text   REFERENCES permission(key),
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE "user" (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email             text NOT NULL UNIQUE,
  password_hash     text NOT NULL,
  totp_secret_enc   bytea,
  workstation_pin_hash text,
  is_platform_staff boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'invited',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_account_role (
  user_id    bigint REFERENCES "user"(id),
  account_id bigint REFERENCES account(id),
  role_id    bigint REFERENCES role(id),
  PRIMARY KEY (user_id, account_id, role_id)
);

CREATE TABLE user_property_role (
  user_id     bigint REFERENCES "user"(id),
  property_id bigint REFERENCES property(id),
  role_id     bigint REFERENCES role(id),
  PRIMARY KEY (user_id, property_id, role_id)
);

CREATE TABLE support_session (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id       bigint NOT NULL,
  platform_user_id bigint NOT NULL,
  granted_by       bigint,                -- Nutzer des Kunden, NULL bei Notfall
  reason           text NOT NULL,
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz
);

CREATE TABLE oauth_client (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id     bigint NOT NULL,
  name           text NOT NULL,
  secret_hash    text NOT NULL,
  scopes         text[] NOT NULL,          -- Schluessel aus permission
  property_ids   bigint[] NOT NULL
);
```

`role`, `role_permission` und `user` sind Härtegrad 3 mit Audit-Trigger. Rollenänderungen sind sicherheitsrelevant und müssen nachvollziehbar sein.

---

## 8. Wirkung zur Laufzeit

1. **Bei der Anmeldung** berechnet die Anwendung die wirksamen Berechtigungen je Property und legt sie in die Sitzung. Bei Rollenänderung werden alle Sitzungen des Nutzers ungültig.
2. **Je Anfrage** setzt die Middleware `app.property_ids`, `app.account_ids` und `app.user_id` transaktionslokal. Row Level Security filtert danach die Daten.
3. **Je Route** ist die nötige Berechtigung deklariert. Die Middleware prüft sie gegen die Sitzung für die angesprochene Property. Fehlt sie, `403`, bevor eine Abfrage läuft.
4. **Der generische Berechtigungstest** aus S13 in [12-security-und-performance-review.md](12-security-und-performance-review.md) prüft jede Route mit jeder Systemrolle: Was die Rolle darf, geht durch, was sie nicht darf, wird abgewiesen. Eine Route ohne deklarierte Berechtigung bricht den Build.

**Trennung der Zuständigkeiten:** RLS entscheidet, **welche Zeilen** ein Nutzer überhaupt sehen kann. Die Berechtigungsprüfung entscheidet, **welche Handlung** er darauf ausführen darf. Beides zusammen, nie eines allein.

---

## 9. Was später kommt

- **Eigene Rollen je Account** aus dem Katalog, Stufe 3.
- **SSO** über den Firmenverzeichnisdienst einer Kette, dann über Keycloak oder Zitadel statt der eingebetteten Bibliothek.
- **Zeitfenster für Rollen**, etwa Aushilfe nur an Wochenenden.
- **Vier-Augen-Prinzip** für Gutschriften über einem Betrag.
