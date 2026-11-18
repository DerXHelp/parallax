import type { en } from './en';

/** German texts of namespace `preferences` (same shape as en.ts). */
export const de: typeof en = {
  menuItem: 'Einstellungen…',
  title: 'Einstellungen',
  description: 'Änderungen gelten sofort und werden vom Parallax-Server gespeichert.',
  sections: {
    label: 'Bereiche der Einstellungen',
    general: 'Allgemein',
    notifications: 'Benachrichtigungen',
    sessions: 'Sessions',
    files: 'Dateien',
    profiles: 'Profile',
    server: 'Server',
    multiHost: 'Mehrere Rechner',
    updates: 'Updates',
    about: 'Über',
    unsaved: 'ungespeicherte Änderungen',
  },
  closeConfirm: {
    title: 'Ungespeicherte Profiländerungen verwerfen?',
    description:
      'Im Profil-Editor gibt es Änderungen, die noch nicht gespeichert sind. Beim Schließen der Einstellungen gehen sie verloren.',
    keep: 'Weiter bearbeiten',
    discard: 'Verwerfen und schließen',
  },
  dismissError: 'Ausblenden',
  general: {
    languageHint: 'Sprache der App und der Windows-Benachrichtigungen.',
    themeHint: '„System“ folgt der Windows-Einstellung. Das Einstellungsmenü bietet dieselbe Schnellwahl.',
    transcript: 'Transkript',
    transcriptHint:
      'Kompakt: Die Arbeitsschritte zwischen zwei Nachrichten bilden eine Zeile (Klick öffnet sie), Bilder bleiben als Galerie sichtbar. Alle Schritte: jeder Schritt in einer eigenen Zeile. Gilt für alle Fenster und Browser.',
    transcriptViews: { compact: 'Kompakt', all: 'Alle Schritte' },
    hooks: 'Hook-Läufe',
    hooksHint:
      'Fehlgeschlagene Läufe erscheinen als Fehler mit ihrer Ausgabe. Alle: auch erfolgreiche, als Schritte. Aus: keine – ein fehlgeschlagener Start-Hook bleibt sichtbar.',
    hookDisplays: { all: 'Alle', failed: 'Nur fehlgeschlagene und blockierende', off: 'Aus' },
  },
  notifications: {
    events: 'Ereignisse',
    eventsHint:
      'Je Ereignis: eine Windows-Benachrichtigung und ein Ton. Parallax zeigt jede Benachrichtigung nur einmal.',
    columns: {
      event: 'Ereignis',
      toast: 'Windows-Benachrichtigung',
      sound: 'Ton',
    },
    kinds: {
      permission: 'Braucht Freigabe',
      question: 'Frage',
      plan: 'Plan prüfen',
      done: 'Fertig',
      error: 'Fehler',
      rate_limit: 'Limit erreicht',
    },
    toastFor: 'Windows-Benachrichtigung: {event}',
    soundFor: 'Ton: {event}',
    soundIdFor: 'Klang: {event}',
    previewFor: 'Klang für „{event}“ anhören',
    volume: 'Lautstärke',
    volumeValue: '{percent} %',
    doNotDisturb: 'Nicht stören',
    doNotDisturbHint:
      'Keine Windows-Benachrichtigungen und keine Töne. Hinweise im Fenster und die Anzahl im Fenstertitel bleiben.',
    focusedElsewhere: 'Ist ein Parallax-Fenster im Vordergrund und zeigt eine andere Session',
    focusedElsewhereInApp: 'Hinweis im Fenster zeigen',
    focusedElsewhereSystem: 'Windows-Benachrichtigung zeigen',
    doneMinSeconds: 'Mindestdauer für „Fertig“',
    doneMinSecondsHint:
      'Ist ein Parallax-Fenster im Vordergrund, wird „Fertig“ nur für Turns gemeldet, die mindestens so lange gedauert haben. Im Hintergrund zählt jeder fertige Turn.',
    seconds: 'Sekunden',
    openOnClick: 'Klick auf eine Windows-Benachrichtigung öffnet die Session',
    openOnClickHint:
      'Registriert den Linktyp „parallax:“ für deinen Windows-Benutzer; ein Klick öffnet die Session in einem neuen App-Fenster.',
    openOnClickForeign:
      'Für „parallax:“-Links ist bei deinem Windows-Benutzer schon ein anderes Programm registriert. Parallax ersetzt es nicht.',
  },
  sessions: {
    idleSleep: 'Untätige Sessions schlafen legen',
    idleSleepHint:
      'Beendet den Claude-Prozess einer Session, die so lange auf nichts gewartet hat; der nächste Prompt setzt sie fort. Eine Session, die ein Fenster im Vordergrund zeigt, schläft nie.',
    idleMinutes: 'Untätig bis zum Schlafen',
    minutes: 'Minuten',
    promptSuggestions: 'Prompt-Vorschläge',
    promptSuggestionsHint:
      'Claude schlägt den nächsten Prompt als grauen Text im Eingabefeld vor (Tab übernimmt ihn). Kostet einen zusätzlichen Request je Turn. Wirkt ab dem nächsten Start einer Session.',
    remoteControl: 'Remote Control für neue Sessions',
    remoteControlHint:
      'Öffnet eine neue Session zusätzlich in der Claude-App (Handy oder claude.ai), damit du sie dort verfolgen und beantworten kannst. Bestehende Sessions behalten ihre eigene Wahl (Menü der Kopfzeile).',
    remoteFollow: 'Wie Claude-Einstellung ({detected})',
    remoteDetectedOn: 'zurzeit an',
    remoteDetectedOff: 'zurzeit aus',
    remoteDetectedUnknown: 'noch nicht gelesen – bekannt nach dem ersten Session-Start',
    remoteOptions: {
      on: 'Immer an',
      off: 'Aus',
    },
  },
  server: {
    port: 'Port',
    portPlaceholder: '{port} (Standard)',
    portHint: 'Leer = Standardport {port}. Wirkt nach „Server beenden“ und einem Neustart von Parallax.',
    currentPort: 'Aktueller Port: {port}',
    autostart: 'Parallax beim Anmelden an Windows starten',
    autostartHint:
      'Startet den Server im Hintergrund; Windows-Benachrichtigungen funktionieren auch ohne Fenster.',
    openWindow: 'Beim Anmelden auch ein Fenster öffnen',
    openWindowNeedsAutostart: 'Nur, solange „Parallax beim Anmelden an Windows starten“ eingeschaltet ist.',
    autostartForeign:
      'Im Autostart-Ordner liegt schon eine „Parallax.lnk“, die nicht von Parallax stammt. Parallax ersetzt sie nicht – benenne sie um oder lösche sie, um diese Einstellung zu nutzen.',
  },
  profiles: {
    unavailable: 'Der Profil-Editor ist in dieser Ansicht nicht verfügbar.',
  },
  updates: {
    unavailable: 'Updates sind in dieser Ansicht nicht verfügbar.',
  },
  multiHost: {
    role: {
      label: 'Rolle dieses Rechners',
      hint: 'Rechner im selben Netz können zusammenarbeiten: Ein freigebender Rechner lässt einen gekoppelten Rechner seine Sessions steuern; ein steuernder Rechner zeigt die Sessions freigebender Rechner. Immer nur eine Rolle.',
      options: {
        off: 'Aus',
        share: 'Freigeben',
        control: 'Andere steuern',
      },
      descriptions: {
        off: 'Dieser Rechner ist im Netz nicht erreichbar. Kopplungen bleiben erhalten.',
        share: 'Ein gekoppelter Rechner im selben Netz darf die Sessions dieses Rechners steuern.',
        control: 'Dieser Rechner zeigt und steuert die Sessions freigebender Rechner im selben Netz.',
      },
      saving: 'Rolle wird gewechselt…',
      failed: 'Die Rolle wurde nicht geändert.',
      conflictShare: 'Hebe zuerst die Kopplung auf – danach kann dieser Rechner andere steuern.',
      conflictControl:
        'Entferne zuerst alle Rechner unter „Andere steuern“ – danach kann dieser Rechner freigeben.',
      unpairAction: 'Kopplung aufheben…',
    },
    off: 'Schalte „Freigeben“ ein, damit ein anderer Rechner im selben Netz diesen steuern kann, oder „Andere steuern“, um von hier einen freigebenden Rechner zu steuern.',
    share: {
      starting: 'Freigeben wird eingerichtet…',
      status: {
        heading: 'Fernzugang',
        listening: 'Erreichbar',
        stopped: 'Nicht erreichbar',
        listeningOn: 'Lauscht auf Port {port}.',
        addresses: 'Adressen dieses Rechners: {addresses}',
        noAddresses: 'Es wurde keine Netzadresse dieses Rechners gefunden.',
        hostName: 'Rechnername: {name}',
        failedReasons: {
          port_in_use: 'Ein anderes Programm nutzt Port {port}. Wähle unten einen anderen Port.',
          bind: 'Die gewählte Adresse gehört nicht zu diesem Rechner. Wähle unten eine andere Adresse.',
          tls_unsupported:
            'Diesem Node.js fehlt die nötige Verschlüsselung (ML-KEM, ML-DSA). Aktualisiere Node.js, um freizugeben.',
          listen: 'Windows hat das Lauschen auf dem Port nicht erlaubt.',
          store:
            'Die Kopplungsdatei konnte nicht geschrieben werden. Der Fernzugang bleibt aus, bis das gelingt.',
        },
      },
      checks: {
        label: 'Prüfungen',
        recheck: 'Erneut prüfen',
        checking: 'Prüfe…',
        failed: 'Die Prüfungen konnten nicht laufen.',
        status: { ok: 'OK', warning: 'Hinweis', error: 'Problem' },
        names: {
          port: 'Port',
          keys: 'Schlüssel und Zertifikat',
          keystore: 'Windows-Schlüsselspeicher',
          tls: 'Verschlüsselung (TLS 1.3, ML-KEM, ML-DSA)',
          addresses: 'Netzadressen',
          firewall: 'Windows-Firewall',
        },
        details: {
          port: {
            warning: 'Der Port konnte nicht geprüft werden.',
            error: 'Ein anderes Programm nutzt den Port.',
          },
          keys: {
            warning: 'Der Schlüssel wurde neu erzeugt – kopple den steuernden Rechner erneut.',
            error: 'Der Schlüssel oder sein Zertifikat konnte nicht erzeugt oder geladen werden.',
          },
          keystore: {
            warning: 'Der Windows-Schlüsselspeicher hat langsam geantwortet.',
            error:
              'Der Windows-Schlüsselspeicher ist nicht verfügbar; Schlüssel können nicht sicher gespeichert werden.',
          },
          tls: {
            warning: 'Der Selbsttest der Verschlüsselung hat ein Problem gemeldet.',
            error: 'Der Selbsttest der Verschlüsselung ist fehlgeschlagen.',
          },
          addresses: {
            warning: 'Es wurde keine Adresse in einem lokalen Netz gefunden.',
            error: 'Es wurde keine Netzadresse dieses Rechners gefunden.',
          },
          firewall: {
            warning:
              'Noch keine Firewall-Regel für Node.js gefunden – Windows fragt beim Start des Fernzugangs nach.',
            error: 'Die Firewall blockiert Verbindungen zum Port.',
          },
        },
      },
      firewall: {
        title: 'Windows-Firewall',
        body: 'Beim ersten Start des Fernzugangs fragt Windows eventuell, ob Node.js in Netzwerken kommunizieren darf. Erlaube es nur für private Netzwerke. Ohne diese Erlaubnis kann sich der andere Rechner nicht verbinden; je nach Rechner braucht das Erlauben Administratorrechte.',
      },
      pairing: {
        heading: 'Rechner koppeln',
        hint: 'Zeigt einen einmaligen Code. Gib ihn innerhalb von {minutes} Minuten am steuernden Rechner unter „Andere steuern“ ein; nach {failures} falschen Eingaben verfällt der Code.',
        start: 'Rechner koppeln',
        starting: 'Code wird erzeugt…',
        codeLabel: 'Kopplungscode',
        validFor: 'Gültig noch {time}',
        minutesLeft: {
          one: 'Der Kopplungscode gilt noch {count} Minute.',
          other: 'Der Kopplungscode gilt noch {count} Minuten.',
        },
        computer: 'Rechnername',
        addresses: 'Adresse',
        port: 'Port',
        cancel: 'Koppeln abbrechen',
        cancelled: 'Das Koppeln wurde abgebrochen.',
        expired: 'Der Code ist abgelaufen. Starte das Koppeln bei Bedarf erneut.',
        closed: 'Das Kopplungsfenster wurde geschlossen (zum Beispiel nach zu vielen falschen Codes).',
        paired: 'Gekoppelt mit {name}.',
        openElsewhere:
          'Ein Kopplungsfenster ist bis {time} offen. Sein Code wurde in einem anderen Fenster angezeigt.',
        newCode: 'Neuen Code anzeigen',
        replaceTitle: 'Kopplung mit {name} ersetzen?',
        replaceBody:
          'Es kann nur ein Rechner gekoppelt sein. Die bisherige Kopplung bleibt, bis der neue Rechner erfolgreich gekoppelt ist.',
        replaceConfirm: 'Neuen Rechner koppeln',
        keep: 'Kopplung behalten',
        failed: 'Das Koppeln konnte nicht starten.',
      },
      peer: {
        heading: 'Gekoppelter Rechner',
        none: 'Noch kein Rechner gekoppelt.',
        connected: {
          one: 'Verbunden ({count} Verbindung)',
          other: 'Verbunden ({count} Verbindungen)',
        },
        disconnected: 'Nicht verbunden',
        incompatible: 'Andere Parallax-Version',
        incompatibleHint:
          'Auf dem steuernden Rechner läuft Parallax {version}. Er wird abgelehnt, bis auf beiden Rechnern dieselbe Version läuft.',
        unknownVersion: 'unbekannt',
        pairedAt: 'Gekoppelt seit',
        lastSeen: 'Letzter Kontakt',
        never: 'Noch keiner',
        lastAddress: 'Letzte Adresse',
        noAddress: 'Unbekannt',
        unpair: 'Kopplung aufheben…',
        unpairTitle: 'Kopplung mit {name} aufheben?',
        unpairBody:
          'Seine Verbindungen werden sofort getrennt. Um diesen Rechner wieder zu steuern, muss er neu gekoppelt werden.',
        unpairConfirm: 'Kopplung aufheben',
        unpaired: 'Die Kopplung wurde aufgehoben.',
        renew: 'Schlüssel erneuern…',
        renewTitle: 'Schlüssel dieses Rechners erneuern?',
        renewBodyPaired:
          'Ein neuer Schlüssel hebt auch die Kopplung mit {name} auf; seine Verbindungen werden sofort getrennt. Kopple danach neu.',
        renewBody:
          'Dieser Rechner bekommt einen neuen Schlüssel. Früher gekoppelte Rechner können sich nicht mehr verbinden.',
        renewConfirm: 'Schlüssel erneuern',
        renewed: 'Der Schlüssel wurde erneuert.',
        cancel: 'Abbrechen',
        failed: 'Die Aktion ist fehlgeschlagen.',
      },
      listener: {
        heading: 'Port und Adresse',
        port: 'Port',
        portHint:
          'Der steuernde Rechner verbindet sich mit diesem Port. Trage nach einer Änderung den neuen Port auch dort ein.',
        bindAddress: 'Adresse',
        bindAddressHint: 'Alle Adressen oder nur ein Netz dieses Rechners.',
        allAddresses: 'Alle Adressen ({address})',
        failed: 'Die Einstellung wurde nicht gespeichert.',
      },
      log: {
        heading: 'Verbindungsprotokoll',
        hint: 'Jeder Versuch, sich mit diesem Rechner zu verbinden, zusammengefasst je Adresse und Minute. Einträge bleiben {days} Tage erhalten.',
        onlyRejected: 'Nur abgelehnte Versuche',
        refresh: 'Aktualisieren',
        loading: 'Protokoll wird geladen…',
        failed: 'Das Protokoll konnte nicht geladen werden.',
        retry: 'Erneut versuchen',
        empty: 'Noch keine Einträge.',
        emptyRejected: 'Keine abgelehnten Versuche.',
        columns: { time: 'Zeit', address: 'IP-Adresse', kind: 'Ereignis', count: 'Anzahl', name: 'Name' },
        count: '{count}×',
        rejected: 'abgelehnt',
        noName: '–',
        unverified: 'ungeprüft',
        unverifiedHint: 'Die Gegenseite hat diesen Namen selbst angegeben; er ist nicht geprüft.',
        kinds: {
          pair_ok: 'Gekoppelt',
          pair_failed: 'Koppeln fehlgeschlagen',
          pair_expired: 'Kein Kopplungsfenster offen',
          pair_rate_limited: 'Zu viele Kopplungsversuche',
          unknown_key: 'Unbekannter Schlüssel',
          revoked_key: 'Schlüssel einer aufgehobenen Kopplung',
          bad_certificate: 'Unbrauchbares Zertifikat',
          proof_failed: 'Verbindungsbeweis fehlgeschlagen',
          tls_failed: 'Verschlüsselung abgebrochen',
          rate_limited: 'Zu viele Verbindungen',
          browser_rejected: 'Browser-Anfrage abgelehnt',
          version_mismatch: 'Andere Parallax-Version',
          connected: 'Verbunden',
          disconnected: 'Getrennt',
          unpaired: 'Kopplung aufgehoben',
        },
      },
    },
    control: {
      placeholder:
        'Hier fügst du freigebende Rechner im selben Netz mit ihrem Kopplungscode hinzu und siehst ihren Zustand. Dieser Teil folgt in einer späteren Version.',
    },
  },
  files: {
    editor: 'Editor für „Im Editor öffnen“',
    editorHint:
      'Parallax öffnet eine Datei in diesem Programm an der genannten Zeile. Standard ist Notepad++; die Änderung gilt ab der nächsten geöffneten Datei.',
    presets: {
      notepadpp: 'Notepad++',
      vscode: 'Visual Studio Code',
      custom: 'Eigenes Programm',
      system: 'Windows-Standardprogramm',
    },
    defaultBadge: 'Standard',
    detecting: 'Programm wird gesucht…',
    found: 'Gefunden: {path}',
    notFound: 'Auf diesem Computer nicht gefunden',
    detectFailed: 'Es ließ sich nicht prüfen, welche Editoren installiert sind.',
    systemHint:
      'Öffnet eine Datei mit dem Programm, das Windows ihrem Typ zuordnet – nur für harmlose Typen ({extensions}). Andere Dateien lassen sich so nicht öffnen.',
    path: 'Programm (.exe)',
    pathOptional: 'Eigener Pfad (optional)',
    pathOptionalHint:
      'Leer = die Installation, die Parallax gefunden hat. Gib den vollständigen Pfad einer .exe an, um eine andere zu nutzen.',
    customHint: 'Der vollständige lokale Pfad der .exe-Datei des Programms.',
    pathPlaceholder: 'C:\\Programme\\Editor\\editor.exe',
    pathExists: 'Das Programm ist vorhanden.',
    pathMissing: 'Unter diesem Pfad gibt es kein Programm (mehr).',
    args: 'Argumente',
    argsHint: 'Ein Argument pro Zeile. Platzhalter: {file} (Pflicht), {line} und {col} (1, wenn unbekannt).',
    preview: 'Kommandozeile (Beispiel)',
    previewHint: 'Für Zeile {line}, Spalte {col} von {sample}.',
    save: 'Editor speichern',
    unsaved: 'Noch nicht gespeichert',
    issues: {
      path: 'Gib einen vollständigen lokalen Pfad an (etwa C:\\…) – keinen Netzwerk- und keinen relativen Pfad.',
      not_exe: 'Das Programm muss eine .exe-Datei sein.',
      blocked:
        'Dieses Programm kann nicht der Editor sein (Shells, Skript-Hosts und der Explorer sind gesperrt).',
      required: 'Gib den Pfad des Programms an.',
      file_placeholder: 'Ein Argument muss {placeholder} enthalten.',
      too_long: 'Dieser Eintrag ist zu lang.',
      too_many: 'Höchstens {max} Argumente.',
      invalid: 'Dieser Eintrag ist ungültig.',
    },
  },
  systemIntegrationOff:
    'Nur beim installierten Parallax-Server verfügbar (Standard-Datenordner, echtes Claude Code, kein Entwicklungsmodus).',
  validation: {
    range: 'Gib eine ganze Zahl von {min} bis {max} ein.',
    rangeOrEmpty: 'Lass das Feld leer oder gib eine ganze Zahl von {min} bis {max} ein.',
  },
  sounds: {
    names: {
      chime: 'Glockenspiel',
      ping: 'Ping',
      pop: 'Plopp',
      bell: 'Glocke',
      alert: 'Warnton',
    },
    locked:
      'Töne aktivieren: Klicke irgendwo in dieses Fenster oder drücke eine Taste – Browser spielen Töne erst danach ab.',
  },
};
