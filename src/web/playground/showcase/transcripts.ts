import type { TranscriptItem } from '@shared/model';
import { PAYPAL_ADAPTER, REMINDER_SERVICE, SHOWCASE_FILE_PATHS, SHOWCASE_ROOTS } from './files';
import { PLAN_FILE, PLAN_V1, PLAN_V2 } from './plans';
import { numbered, transcriptBuilder } from './transcript-builder';

/**
 * The showcase transcripts (WP-68): prompts and answers in German, code, commands and CLI output
 * in English. Times are seconds before "now"; the three featured sessions (PayPal, rate limiting,
 * push notifications) are the richest, the others just enough to click through.
 */

export const OPUS = 'claude-opus-5-5';
export const SONNET = 'claude-sonnet-5-5';
export const HAIKU = 'claude-haiku-5-5';

const shop = (path: string) => `${SHOWCASE_ROOTS.shop}\\${path}`;
const api = (path: string) => `${SHOWCASE_ROOTS.api}\\${path}`;
const infra = (path: string) => `${SHOWCASE_ROOTS.infra}\\${path}`;

/** Decision ids of the showcase (the decisions themselves are built in data.ts). */
export const SHOWCASE_DECISION_IDS = {
  lighthouse: 'dc_00000000000000000000000000068201',
  planV1: 'dc_00000000000000000000000000068401',
  planV2: 'dc_00000000000000000000000000068402',
} as const;

// ---- nordlicht-shop: PayPal Express (working, the overview) ----

const PAYMENT_STEP_PATCH = [
  {
    oldStart: 15,
    oldLines: 6,
    newStart: 15,
    newLines: 14,
    lines: [
      '     <section aria-labelledby="payment-heading" className="space-y-6">',
      '       <h2 id="payment-heading" className="text-lg font-semibold">Zahlung</h2>',
      '       <PaymentMethodList methods={methods} selected={method} onSelect={setMethod} />',
      '+      {paypalEnabled && (',
      '+        <PayPalButtons',
      "+          style={{ layout: 'horizontal', label: 'checkout' }}",
      "+          createOrder={() => createOrder('paypal')}",
      "+          onApprove={({ orderID }) => confirmOrder('paypal', orderID)}",
      "+          onError={() => setError('PayPal ist gerade nicht erreichbar.')}",
      '+        />',
      '+      )}',
      '       <OrderSummary cart={cart} />',
      '       {error && <p role="alert" className="text-sm text-red-600">{error}</p>}',
      '     </section>',
    ],
  },
];

function paypalTranscript(now: number): TranscriptItem[] {
  const b = transcriptBuilder('paypal', 0x681, now, OPUS);
  b.user(
    'Bau PayPal Express in den Checkout ein: Button im Schritt „Zahlung“ unter den Zahlarten, die Bestellung erst nach onApprove anlegen. Sandbox-Zugang steht in .env.local. Bitte mit Tests.',
    410,
  );
  b.thinking(
    'The checkout already has a provider registry. Look at PaymentStep, the registry and how orders are created before adding a new provider.',
    404,
  );
  b.tool(
    'TodoWrite',
    {
      todos: [
        { content: 'PayPal-Adapter anlegen', status: 'in_progress', activeForm: 'Lege PayPal-Adapter an' },
        { content: 'Button im Zahlschritt einbauen', status: 'pending', activeForm: 'Baue Button ein' },
        { content: 'Checkout-Tests ausführen', status: 'pending', activeForm: 'Führe Checkout-Tests aus' },
        {
          content: 'Sandbox-Bestellung end-to-end prüfen',
          status: 'pending',
          activeForm: 'Prüfe Sandbox-Bestellung',
        },
      ],
    },
    400,
    { output: 'Todos have been modified successfully.' },
  );
  b.tool('Glob', { pattern: 'src/**/*{payment,checkout}*' }, 396, {
    output: [
      'src/app/checkout/PaymentStep.tsx',
      'src/app/checkout/PaymentMethodList.tsx',
      'src/app/checkout/useCheckout.ts',
      'src/lib/payments/registry.ts',
    ].join('\n'),
  });
  b.tool('Read', { file_path: shop('src\\app\\checkout\\PaymentStep.tsx') }, 392, {
    output: numbered(
      "'use client';\n\nimport { useRouter } from 'next/navigation';\nimport { useState } from 'react';",
    ),
  });
  b.tool('Read', { file_path: SHOWCASE_FILE_PATHS.registry }, 389, {
    output: numbered(
      "import type { Cart } from '@/lib/cart';\nimport { invoice } from './invoice';\nimport { klarna } from './klarna';",
    ),
  });
  b.tool('Grep', { pattern: 'createOrder', output_mode: 'files_with_matches' }, 385, {
    output:
      'Found 3 files\nsrc/app/api/orders/route.ts\nsrc/app/checkout/useCheckout.ts\nsrc/lib/payments/klarna.ts',
  });
  b.tool('Read', { file_path: shop('src\\app\\checkout\\useCheckout.ts') }, 381, {
    output: numbered(
      "import { useCart } from '@/lib/cart';\nimport { providers } from '@/lib/payments/registry';",
    ),
  });
  b.text(
    [
      'Der Checkout hat schon eine Zahlarten-Registry (`src/lib/payments/registry.ts`), Bestellungen legt `POST /api/orders` an. PayPal wird eine weitere Zahlart:',
      '',
      '1. **Adapter** `src/lib/payments/paypal.ts` – erstellt die PayPal-Order und bucht sie nach `onApprove` ab.',
      '2. **Button** im `PaymentStep`, nur sichtbar, wenn PayPal im Shop aktiv ist.',
    ].join('\n'),
    360,
  );
  b.tool('Write', { file_path: SHOWCASE_FILE_PATHS.paypal, content: PAYPAL_ADAPTER }, 300, {
    output: `File created successfully at: ${SHOWCASE_FILE_PATHS.paypal}`,
    structured: { type: 'create', structuredPatch: [] },
  });
  b.text(
    'Jetzt der Button im Zahlschritt. Die Liste der Zahlarten bleibt, PayPal steht darunter und legt die Bestellung erst in `onApprove` an:',
    240,
  );
  b.tool(
    'Edit',
    {
      file_path: SHOWCASE_FILE_PATHS.paymentStep,
      old_string:
        '      <PaymentMethodList methods={methods} selected={method} onSelect={setMethod} />\n      <OrderSummary cart={cart} />',
      new_string: [
        '      <PaymentMethodList methods={methods} selected={method} onSelect={setMethod} />',
        '      {paypalEnabled && (',
        '        <PayPalButtons',
        "          style={{ layout: 'horizontal', label: 'checkout' }}",
        "          createOrder={() => createOrder('paypal')}",
        "          onApprove={({ orderID }) => confirmOrder('paypal', orderID)}",
        "          onError={() => setError('PayPal ist gerade nicht erreichbar.')}",
        '        />',
        '      )}',
        '      <OrderSummary cart={cart} />',
      ].join('\n'),
    },
    230,
    {
      output: `The file ${SHOWCASE_FILE_PATHS.paymentStep} has been updated successfully.`,
      structured: { type: 'update', structuredPatch: PAYMENT_STEP_PATCH, userModified: false },
    },
  );
  b.text('Adapter und Button stehen. Ich lasse die Checkout- und Zahlungs-Tests laufen:', 40);
  b.tool(
    'Bash',
    {
      command: 'pnpm vitest run checkout payments',
      description: 'Tests ausführen',
    },
    23,
    { status: 'running', output: null, elapsedSeconds: 23 },
  );
  return b.items;
}

// ---- nordlicht-shop: Lighthouse (waiting for a permission) ----

function lighthouseTranscript(now: number): TranscriptItem[] {
  const b = transcriptBuilder('lighthouse', 0x682, now, SONNET);
  b.user(
    'Lighthouse meckert auf der Startseite über die Hero-Bilder (LCP 4,1 s). Bitte auf next/image mit AVIF umstellen und danach einen Produktionsbuild machen.',
    760,
  );
  b.tool('Read', { file_path: shop('src\\app\\(home)\\Hero.tsx') }, 752, {
    output: numbered("import heroWinter from '@/assets/hero-winter.jpg';"),
  });
  b.tool('Read', { file_path: shop('next.config.ts') }, 749, {
    output: numbered("import type { NextConfig } from 'next';"),
  });
  b.text(
    'Die Hero-Bilder werden als `<img>` mit 2400 px breiten JPGs geladen. Ich stelle auf `next/image` mit `priority` und `sizes` um und aktiviere AVIF.',
    700,
  );
  b.tool(
    'Edit',
    {
      file_path: shop('next.config.ts'),
      old_string: '  images: {},',
      new_string: "  images: { formats: ['image/avif', 'image/webp'] },",
    },
    640,
    { output: 'The file has been updated successfully.' },
  );
  b.tool(
    'Edit',
    {
      file_path: shop('src\\app\\(home)\\Hero.tsx'),
      old_string: '<img src={heroWinter.src} alt="" className="h-full w-full object-cover" />',
      new_string:
        '<Image src={heroWinter} alt="" priority sizes="100vw" className="h-full w-full object-cover" />',
    },
    600,
    { output: 'The file has been updated successfully.' },
  );
  b.text('Bilder umgestellt. Für die Messung brauche ich einen Produktionsbuild:', 130);
  b.tool('Bash', { command: 'pnpm build', description: 'Produktionsbuild erstellen' }, 120, {
    status: 'awaiting_decision',
    output: null,
    decision: {
      decisionId: SHOWCASE_DECISION_IDS.lighthouse,
      kind: 'permission',
      planVersion: null,
      outcome: null,
    },
  });
  return b.items;
}

// ---- nordlicht-shop: product filter (done, unread) ----

function filterTranscript(now: number): TranscriptItem[] {
  const b = transcriptBuilder('filter', 0x683, now, SONNET);
  b.user(
    'Der Produktfilter soll Mehrfachauswahl bei Farbe und Größe können, die Auswahl muss in der URL stehen.',
    2400,
  );
  b.tool('Read', { file_path: shop('src\\app\\produkte\\FilterBar.tsx') }, 2390, {
    output: numbered("'use client';"),
  });
  b.tool('Read', { file_path: shop('src\\lib\\filters.ts') }, 2386, {
    output: numbered('export type Filter = {'),
  });
  b.tool(
    'Edit',
    {
      file_path: shop('src\\lib\\filters.ts'),
      old_string: 'color?: string;',
      new_string: 'colors: string[];',
    },
    2200,
  );
  b.tool(
    'Edit',
    {
      file_path: shop('src\\app\\produkte\\FilterBar.tsx'),
      old_string: 'onChange={setColor}',
      new_string: 'onChange={toggleColor}',
    },
    2100,
  );
  b.tool(
    'Bash',
    { command: 'pnpm vitest run src/lib/filters.test.ts', description: 'Filter-Tests ausführen' },
    1900,
    {
      output:
        ' ✓ src/lib/filters.test.ts (14 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  14 passed (14)',
    },
  );
  b.text(
    'Farbe und Größe sind jetzt Mehrfachauswahl. Die Auswahl steht als `?farbe=blau,grau&groesse=m,l` in der URL, Zurück im Browser stellt den Filter wieder her. Alle 14 Filter-Tests sind grün.',
    1860,
  );
  b.turn(1855, { durationMs: 545_000, numTurns: 14, costUsdTotal: 0.61, costUsdTurn: 0.61 });
  return b.items;
}

// ---- fahrplan-api: rate limiting (plan v2 waiting, the plan shot) ----

function rateLimitTranscript(now: number): TranscriptItem[] {
  const b = transcriptBuilder('ratelimit', 0x684, now, OPUS);
  b.user(
    'Für /v2/connections brauchen wir Rate-Limiting: pro API-Key 60 Anfragen pro Minute, Redis läuft schon. Erst planen, noch nichts ändern.',
    1560,
  );
  b.tool('Read', { file_path: api('app\\main.py') }, 1552, {
    output: numbered('from fastapi import FastAPI'),
  });
  b.tool('Read', { file_path: SHOWCASE_FILE_PATHS.connections }, 1549, {
    output: numbered('from datetime import datetime'),
  });
  b.tool('Read', { file_path: SHOWCASE_FILE_PATHS.redis }, 1546, {
    output: numbered('from functools import lru_cache'),
  });
  b.tool('Grep', { pattern: 'require_api_key', output_mode: 'files_with_matches' }, 1543, {
    output:
      'Found 4 files\napp/core/auth.py\napp/routers/connections.py\napp/routers/stations.py\ntests/conftest.py',
  });
  b.tool('Read', { file_path: api('tests\\conftest.py') }, 1540, { output: numbered('import pytest') });
  b.tool('Write', { file_path: PLAN_FILE, content: PLAN_V1 }, 1500, {
    output: `File created successfully at: ${PLAN_FILE}`,
  });
  b.tool('ExitPlanMode', { plan: PLAN_V1, planFilePath: PLAN_FILE }, 1490, {
    resultSeconds: 480,
    status: 'done',
    isError: true,
    output:
      '<tool_use_error>Lieber Sliding Window statt Fixed Window, und bei 429 bitte einen Retry-After-Header. Die Limits hängen am Tarif – bitte aus der Datenbank lesen, nicht hart codieren.</tool_use_error>',
    decision: {
      decisionId: SHOWCASE_DECISION_IDS.planV1,
      kind: 'plan',
      planVersion: 1,
      outcome: { type: 'plan_revised' },
    },
  });
  b.text(
    'Verstanden: Sliding Window über ein Sorted Set, `Retry-After` bei 429 und die Limits pro Tarif aus `api_plans`. Ich passe den Plan an.',
    470,
  );
  b.tool('Read', { file_path: api('app\\models\\plan.py') }, 300, {
    output: numbered('class ApiPlan(Base):'),
  });
  b.tool('Edit', { file_path: PLAN_FILE, old_string: '## Schritte', new_string: '## Schritte' }, 262, {
    output: 'The file has been updated successfully.',
  });
  b.tool('ExitPlanMode', { plan: PLAN_V2, planFilePath: PLAN_FILE }, 250, {
    status: 'awaiting_decision',
    output: null,
    decision: { decisionId: SHOWCASE_DECISION_IDS.planV2, kind: 'plan', planVersion: 2, outcome: null },
  });
  return b.items;
}

// ---- fahrplan-api: flaky test (done) and dependencies (sleeping) ----

function flakyTranscript(now: number): TranscriptItem[] {
  const b = transcriptBuilder('flaky', 0x685, now, SONNET);
  b.user('test_departures_timezone schlägt in der CI ab und zu fehl. Findest du raus, warum?', 5400);
  b.tool('Read', { file_path: api('tests\\test_departures.py') }, 5390, {
    output: numbered('from datetime import datetime'),
  });
  b.tool(
    'Bash',
    {
      command: 'pytest tests/test_departures.py -k timezone --count=50 -q',
      description: 'Test 50-mal wiederholen',
    },
    5300,
    {
      output: '..F.......F.......................F...............\n3 failed, 47 passed in 4.12s',
    },
  );
  b.tool(
    'Edit',
    {
      file_path: api('tests\\conftest.py'),
      old_string: 'datetime.now()',
      new_string: 'datetime.now(tz=BERLIN)',
    },
    5000,
  );
  b.tool(
    'Bash',
    {
      command: 'pytest tests/test_departures.py -k timezone --count=50 -q',
      description: 'Test erneut 50-mal wiederholen',
    },
    4900,
    {
      output: '..................................................\n50 passed in 3.98s',
    },
  );
  b.text(
    'Ursache: Die Fixture `frozen_departure` baut ein naives `datetime.now()`. Läuft die CI kurz vor Mitternacht UTC, liegt die Abfahrt in Berlin schon am nächsten Tag. Die Fixture nutzt jetzt `Europe/Berlin` – 50 von 50 Läufen grün.',
    4880,
  );
  b.turn(4875, { durationMs: 520_000, numTurns: 9, costUsdTotal: 0.38, costUsdTurn: 0.38 });
  return b.items;
}

function depsTranscript(now: number): TranscriptItem[] {
  const b = transcriptBuilder('deps', 0x686, now, HAIKU);
  b.user(
    'Bitte alle Abhängigkeiten auf den neuesten Stand bringen, Breaking Changes vorher auflisten.',
    93_000,
  );
  b.tool('Bash', { command: 'uv lock --upgrade', description: 'Lockfile aktualisieren' }, 92_900, {
    output:
      'Resolved 64 packages in 1.84s\nUpdated fastapi v0.118.2 -> v0.121.0\nUpdated pydantic v2.11.9 -> v2.12.3',
  });
  b.tool('Bash', { command: 'uv run pytest -q', description: 'Tests ausführen' }, 92_600, {
    output: '214 passed in 18.40s',
  });
  b.text(
    '12 Pakete aktualisiert, darunter FastAPI 0.121 und Pydantic 2.12 – keine Breaking Changes für uns. Alle 214 Tests sind grün.',
    92_550,
  );
  b.turn(92_540, { durationMs: 460_000, numTurns: 6, costUsdTotal: 0.07, costUsdTurn: 0.07 });
  return b.items;
}

// ---- vereinsapp: push notifications (working, background agent – the files shot) ----

const SETTINGS_PATCH = [
  {
    oldStart: 13,
    oldLines: 6,
    newStart: 13,
    newLines: 12,
    lines: [
      "       appBar: AppBar(title: const Text('Einstellungen')),",
      '       body: ListView(',
      '         children: [',
      '+          SwitchListTile(',
      "+            title: const Text('Erinnerungen an Termine'),",
      "+            subtitle: const Text('24 Stunden und 1 Stunde vorher'),",
      '+            value: settings.reminders,',
      '+            onChanged: settings.setReminders,',
      '+          ),',
      '           SwitchListTile(',
      "             title: const Text('Dunkles Design'),",
      '             value: settings.darkMode,',
    ],
  },
];

function pushTranscript(now: number): TranscriptItem[] {
  const b = transcriptBuilder('push', 0x687, now, SONNET);
  b.user(
    'Push-Benachrichtigungen für Termine: 24 Stunden und eine Stunde vorher erinnern, in den Einstellungen abschaltbar. Firebase ist schon eingerichtet.',
    1080,
  );
  b.tool('Read', { file_path: SHOWCASE_FILE_PATHS.pubspec }, 1072, { output: numbered('name: vereinsapp') });
  b.tool('Glob', { pattern: 'lib/**/*.dart' }, 1069, {
    output: 'lib/main.dart\nlib/models/event.dart\nlib/screens/settings_screen.dart',
  });
  b.tool('Read', { file_path: SHOWCASE_FILE_PATHS.event }, 1066, {
    output: numbered("import 'package:cloud_firestore/cloud_firestore.dart';"),
  });
  b.tool('Grep', { pattern: 'FirebaseMessaging', output_mode: 'files_with_matches' }, 1062, {
    output: 'Found 2 files\nlib/main.dart\nlib/services/push_service.dart',
  });
  b.text(
    'Die Erinnerungen plane ich lokal mit `flutter_local_notifications` – das klappt auch offline. Ein Explore-Agent sucht parallel alle Stellen, an denen Termine entstehen.',
    1000,
  );
  b.tool(
    'Agent',
    {
      description: 'Stellen finden, an denen Termine entstehen',
      subagent_type: 'Explore',
      prompt:
        'Find every place in lib/ where events are created, moved or deleted. Report file, function and whether the start time can change.',
    },
    990,
    {
      status: 'background',
      output: 'Async agent launched successfully.',
      structured: { isAsync: true, status: 'async_launched', resolvedModel: HAIKU },
      task: {
        taskId: 'task_events_scan',
        taskType: 'local_agent',
        status: 'running',
        description: 'Stellen finden, an denen Termine entstehen',
        subagentType: 'Explore',
        isBackgrounded: true,
        summary:
          'Checked 18 of 31 files – events are created in event_repository.dart and moved in event_form_screen.dart',
        usage: { totalTokens: 41_200, toolUses: 23, durationMs: 610_000 },
        startedAt: b.ago(990),
        endedAt: null,
        outputFile: null,
      },
    },
  );
  b.tool('Write', { file_path: SHOWCASE_FILE_PATHS.reminder, content: REMINDER_SERVICE }, 700, {
    output: `File created successfully at: ${SHOWCASE_FILE_PATHS.reminder}`,
    structured: { type: 'create', structuredPatch: [] },
  });
  b.sideQuestion(
    'Brauchen wir für iOS dafür ein eigenes Entitlement?',
    'Für die **lokalen** Erinnerungen nicht – es reicht die Abfrage der Berechtigung zur Laufzeit (`requestPermissions`). Nur für Nachrichten vom Server über FCM brauchst du in Xcode die Capability *Push Notifications*; das Entitlement `aps-environment` legt Xcode dann selbst an.',
    560,
    9,
  );
  b.text(
    'Der Dienst steht: `lib/services/reminder_service.dart` plant je Termin zwei Erinnerungen und räumt alte vorher ab. Der Schalter kommt in `lib/screens/settings_screen.dart`:',
    300,
  );
  b.tool(
    'Edit',
    {
      file_path: SHOWCASE_FILE_PATHS.settingsScreen,
      old_string:
        "        children: [\n          SwitchListTile(\n            title: const Text('Dunkles Design'),",
      new_string: [
        '        children: [',
        '          SwitchListTile(',
        "            title: const Text('Erinnerungen an Termine'),",
        "            subtitle: const Text('24 Stunden und 1 Stunde vorher'),",
        '            value: settings.reminders,',
        '            onChanged: settings.setReminders,',
        '          ),',
        '          SwitchListTile(',
        "            title: const Text('Dunkles Design'),",
      ].join('\n'),
    },
    280,
    {
      output: `The file ${SHOWCASE_FILE_PATHS.settingsScreen} has been updated successfully.`,
      structured: { type: 'update', structuredPatch: SETTINGS_PATCH, userModified: false },
    },
  );
  return b.items;
}

// ---- infra: Postgres 16 on staging (Remote Control, prompt from the Claude app) ----

function postgresTranscript(now: number): TranscriptItem[] {
  const b = transcriptBuilder('postgres', 0x688, now, OPUS);
  b.user(
    'Kannst du prüfen, was für das Upgrade auf Postgres 16 in Staging fehlt? Ich bin unterwegs und schaue später rein.',
    240,
    {
      source: 'remote',
    },
  );
  b.tool('Grep', { pattern: 'engine_version', path: infra('modules') }, 230, {
    output:
      'modules/rds/main.tf:14:  engine_version = var.engine_version\nenvironments/staging/rds.tf:9:  engine_version = "14.12"',
  });
  b.tool('Read', { file_path: infra('environments\\staging\\rds.tf') }, 226, {
    output: numbered('module "rds" {'),
  });
  b.tool(
    'Bash',
    {
      command: 'terraform -chdir=environments/staging plan -target=module.rds',
      description: 'Plan für das RDS-Modul',
    },
    60,
    {
      status: 'running',
      output: null,
      elapsedSeconds: 60,
    },
  );
  return b.items;
}

export const SHOWCASE_TRANSCRIPTS = {
  paypal: paypalTranscript,
  lighthouse: lighthouseTranscript,
  filter: filterTranscript,
  rateLimit: rateLimitTranscript,
  flaky: flakyTranscript,
  deps: depsTranscript,
  push: pushTranscript,
  postgres: postgresTranscript,
} as const;
