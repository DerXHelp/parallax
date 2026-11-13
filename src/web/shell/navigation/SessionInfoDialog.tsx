import { lazy, Suspense, useState, type ComponentType } from 'react';
import { useT } from '@web/i18n';
import { useReturnFocus } from '@web/lib/return-focus';
import { useNarrowWindow } from '@web/shell/sidebar-layout';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@web/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/ui/select';
import { Spinner } from '@web/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/ui/tabs';
import { SlotBoundary } from '../SlotBoundary';
import { sessionFocusTarget } from './focus';
import { useInfoT } from './session-info/i18n';
import { OverviewTab } from './session-info/OverviewTab';
import { INFO_TABS, isInfoTab, readLastTab, writeLastTab, type InfoTab } from './session-info/tabs';

type TabBody = ComponentType<{ sessionKey: string }>;

/**
 * Every tab but the overview is its own lazy chunk (WP-67 start-chunk budget): it is fetched when
 * the tab opens and asks the running CLI then (`session.info`), never before.
 */
const TAB_BODIES: Readonly<Record<Exclude<InfoTab, 'overview'>, TabBody>> = {
  mcp: lazy(() => import('./session-info/McpTab').then((module) => ({ default: module.McpTab }))),
  permissions: lazy(() =>
    import('./session-info/PermissionsTab').then((module) => ({ default: module.PermissionsTab })),
  ),
  skills: lazy(() => import('./session-info/SkillsTab').then((module) => ({ default: module.SkillsTab }))),
  memory: lazy(() => import('./session-info/MemoryTab').then((module) => ({ default: module.MemoryTab }))),
  hooks: lazy(() => import('./session-info/HooksTab').then((module) => ({ default: module.HooksTab }))),
  status: lazy(() => import('./session-info/StatusTab').then((module) => ({ default: module.StatusTab }))),
  export: lazy(() => import('./session-info/ExportTab').then((module) => ({ default: module.ExportTab }))),
};

function TabBodyView({ tab, sessionKey }: { tab: InfoTab; sessionKey: string }) {
  if (tab === 'overview') return <OverviewTab sessionKey={sessionKey} />;
  const Body = TAB_BODIES[tab];
  return (
    <SlotBoundary resetKey={`${sessionKey}|${tab}`}>
      <Suspense fallback={<Spinner />}>
        <Body sessionKey={sessionKey} />
      </Suspense>
    </SlotBoundary>
  );
}

/**
 * Session info (request `sessionInfo`, header menu, `/status` of WP-37), tabbed since WP-67:
 * Overview (from `detail.init`, the last start) · MCP · Permissions · Skills · CLAUDE.md · Hooks ·
 * Status · Export (each asks the running CLI when it opens). A narrow window shows a select instead
 * of the tab row; the last tab is remembered (localStorage). Closing gives the focus back.
 */
export function SessionInfoDialog({ sessionKey, onClose }: { sessionKey: string; onClose: () => void }) {
  const t = useT();
  const it = useInfoT();
  const narrow = useNarrowWindow();
  const returnFocus = useReturnFocus(true, () => sessionFocusTarget(sessionKey));
  const [tab, setTab] = useState<InfoTab>(readLastTab);

  const choose = (value: string): void => {
    if (!isInfoTab(value)) return;
    setTab(value);
    writeLastTab(value);
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        data-slot="session-info"
        data-tab={tab}
        className="flex h-[min(85vh,44rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        onCloseAutoFocus={returnFocus}
      >
        <DialogHeader className="shrink-0 px-6 pt-6 pb-3">
          <DialogTitle>{t('navigation.info.title')}</DialogTitle>
          <DialogDescription>{t('navigation.info.description')}</DialogDescription>
        </DialogHeader>
        {narrow ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-6 pb-3">
              <Select value={tab} onValueChange={choose}>
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  aria-label={it('tabs.choose')}
                  data-slot="session-info-select"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INFO_TABS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {it(`tabs.${value}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div
              role="region"
              aria-label={it(`tabs.${tab}`)}
              className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
              data-slot="session-info-body"
            >
              <TabBodyView tab={tab} sessionKey={sessionKey} />
            </div>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={choose} className="min-h-0 flex-1 gap-0">
            <TabsList aria-label={it('tabs.label')} className="mx-6 w-auto shrink-0 flex-wrap justify-start">
              {INFO_TABS.map((value) => (
                <TabsTrigger key={value} value={value} data-tab={value}>
                  {it(`tabs.${value}`)}
                </TabsTrigger>
              ))}
            </TabsList>
            {INFO_TABS.map((value) => (
              <TabsContent
                key={value}
                value={value}
                className="min-h-0 overflow-y-auto px-6 pt-3 pb-6"
                data-slot="session-info-body"
              >
                <TabBodyView tab={value} sessionKey={sessionKey} />
              </TabsContent>
            ))}
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
