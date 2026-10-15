import { FlaskConicalIcon, MoonIcon, MonitorIcon, SunIcon } from 'lucide-react';
import { Component, useSyncExternalStore, type ReactNode } from 'react';
import { languageSchema, themeSchema } from '@shared/common';
import { useI18n } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { ShellEffects } from '@web/shell/ShellEffects';
import { FeatureSlotsProvider, type FeatureSlots } from '@web/shell/slots';
import { updateSettings, useSettings } from '@web/state/settings';
import { Alert } from '@web/ui/alert';
import { Button } from '@web/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@web/ui/toggle-group';
import { TooltipProvider } from '@web/ui/tooltip';
import { shellDemos } from './demos';
import { demoIdFromHash, hashForDemo } from './route';
import type { PlaygroundDemo, PlaygroundModule } from './types';

/**
 * Playground (`#playground`, dev server only): every demo runs without a server – shell demos over
 * the FakeHost/MemoryTransport, feature demos from `src/web/features/<f>/playground.tsx` (found by
 * `import.meta.glob`, no central list). Deep link: `#playground=<demo id>` (screenshots, WP-20).
 */

interface DemoGroup {
  source: string;
  demos: PlaygroundDemo[];
}

const featureModules = import.meta.glob<PlaygroundModule>('../features/*/playground.tsx', { eager: true });

function featureName(path: string): string {
  return /features\/([^/]+)\/playground\.tsx$/.exec(path)?.[1] ?? path;
}

function collect(): { groups: DemoGroup[]; slots: Partial<FeatureSlots> } {
  const groups: DemoGroup[] = [{ source: 'shell', demos: [...shellDemos] }];
  let slots: Partial<FeatureSlots> = {};
  for (const [path, module] of Object.entries(featureModules).sort(([a], [b]) => a.localeCompare(b))) {
    const source = featureName(path);
    const demos = module.demos ?? [];
    groups.push({ source, demos: demos.map((demo) => ({ ...demo, id: `${source}/${demo.id}` })) });
    if (module.slots !== undefined) slots = { ...slots, ...module.slots };
  }
  return { groups, slots };
}

const { groups: DEMO_GROUPS, slots: DISCOVERED_SLOTS } = collect();
const ALL_DEMOS = DEMO_GROUPS.flatMap((group) => group.demos);

function subscribeHash(listener: () => void): () => void {
  window.addEventListener('hashchange', listener);
  return () => {
    window.removeEventListener('hashchange', listener);
  };
}

function getHash(): string {
  return window.location.hash;
}

function selectDemo(id: string | null): void {
  window.location.hash = hashForDemo(window.location.hash, id);
}

class DemoBoundary extends Component<
  { demoId: string; fallback: (error: Error) => ReactNode; children: ReactNode },
  { error: Error | null; demoId: string }
> {
  override state: { error: Error | null; demoId: string } = { error: null, demoId: this.props.demoId };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: { demoId: string }, state: { demoId: string }) {
    return props.demoId === state.demoId ? null : { error: null, demoId: props.demoId };
  }

  override render(): ReactNode {
    return this.state.error === null ? this.props.children : this.props.fallback(this.state.error);
  }
}

const THEME_ICONS = { dark: MoonIcon, light: SunIcon, system: MonitorIcon } as const;

function SettingsBar() {
  const { t } = useI18n();
  const settings = useSettings();
  return (
    <div className="flex items-center gap-2">
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        aria-label={t('settings.theme')}
        value={settings.theme}
        onValueChange={(value) => {
          const theme = themeSchema.safeParse(value);
          if (theme.success) updateSettings({ theme: theme.data }).catch(() => undefined);
        }}
      >
        {themeSchema.options.map((theme) => {
          const Icon = THEME_ICONS[theme];
          return (
            <ToggleGroupItem key={theme} value={theme} aria-label={t(`settings.themes.${theme}`)}>
              <Icon aria-hidden />
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
      <ToggleGroup
        type="single"
        size="sm"
        variant="outline"
        aria-label={t('settings.language')}
        value={settings.language}
        onValueChange={(value) => {
          const language = languageSchema.safeParse(value);
          if (language.success) updateSettings({ language: language.data }).catch(() => undefined);
        }}
      >
        {languageSchema.options.map((language) => (
          <ToggleGroupItem
            key={language}
            value={language}
            lang={language}
            aria-label={t(`settings.languages.${language}`)}
          >
            {language.toUpperCase()}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

export function PlaygroundApp() {
  const { t } = useI18n();
  const hash = useSyncExternalStore(subscribeHash, getHash, getHash);
  const selectedId = demoIdFromHash(hash);
  const demo = ALL_DEMOS.find((candidate) => candidate.id === selectedId) ?? ALL_DEMOS[0] ?? null;
  const deepLink = demo === null ? '' : `#playground=${demo.id}`;

  return (
    <FeatureSlotsProvider slots={DISCOVERED_SLOTS}>
      <ShellEffects />
      <TooltipProvider>
        <div className="flex h-full min-h-0">
          <nav
            aria-label={t('shell.playground.demos')}
            className="bg-sidebar border-sidebar-border flex w-60 shrink-0 flex-col border-r"
          >
            <div className="flex h-9 items-center gap-2 px-3">
              <FlaskConicalIcon aria-hidden className="text-brand size-4" />
              <span className="font-semibold">{t('shell.playground.title')}</span>
            </div>
            <p className="text-muted-foreground px-3 pb-2 text-2xs">{t('shell.playground.description')}</p>
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-3">
              {DEMO_GROUPS.map((group) => (
                <div key={group.source} className="mb-2">
                  <div className="text-muted-foreground px-2 py-1 text-2xs font-medium tracking-wide uppercase">
                    {group.source}
                  </div>
                  {group.demos.length === 0 ? (
                    <p className="text-muted-foreground px-2 text-2xs">{t('shell.playground.noDemos')}</p>
                  ) : (
                    <ul className="grid gap-px">
                      {group.demos.map((item) => (
                        <li key={item.id}>
                          <button
                            type="button"
                            title={item.description}
                            aria-current={item.id === demo?.id ? 'true' : undefined}
                            onClick={() => {
                              selectDemo(item.id);
                            }}
                            className={cn(
                              'hover:bg-sidebar-accent/70 focus-visible:ring-ring flex min-h-7 w-full items-center rounded-sm px-2 py-1 text-left text-xs outline-none focus-visible:ring-2',
                              item.id === demo?.id && 'bg-sidebar-accent text-sidebar-accent-foreground',
                            )}
                          >
                            {item.title}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </div>
            <div className="border-sidebar-border border-t p-2">
              <Button asChild variant="ghost" size="sm" className="w-full justify-start">
                <a href="/">{t('shell.playground.openApp')}</a>
              </Button>
            </div>
          </nav>
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex h-9 shrink-0 items-center gap-3 border-b px-3">
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{demo?.title}</span>
              <code className="text-muted-foreground hidden text-2xs md:inline">{deepLink}</code>
              <SettingsBar />
            </div>
            <div className="min-h-0 flex-1 overflow-auto" data-demo={demo?.id}>
              {demo === null ? (
                <p className="text-muted-foreground p-6 text-xs">{t('shell.playground.noDemos')}</p>
              ) : (
                <DemoBoundary
                  demoId={demo.id}
                  fallback={(error) => (
                    <div className="p-6">
                      <Alert tone="error" title={t('shell.playground.demoFailed')}>
                        <span className="font-mono">{error.message}</span>
                      </Alert>
                    </div>
                  )}
                >
                  <div key={demo.id} className="h-full">
                    {demo.render()}
                  </div>
                </DemoBoundary>
              )}
            </div>
          </div>
        </div>
      </TooltipProvider>
    </FeatureSlotsProvider>
  );
}
