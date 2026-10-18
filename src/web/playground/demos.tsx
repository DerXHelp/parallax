import { CopyIcon, PlusIcon, SettingsIcon, TrashIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { makeError } from '@shared/errors';
import { useI18n } from '@web/i18n';
import { AppShell } from '@web/shell/AppShell';
import { Alert, Banner } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { Button } from '@web/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@web/ui/card';
import { Checkbox } from '@web/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@web/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@web/ui/dropdown-menu';
import { Gauge } from '@web/ui/gauge';
import { IconButton } from '@web/ui/icon-button';
import { Input } from '@web/ui/input';
import { KbdGroup } from '@web/ui/kbd';
import { Label } from '@web/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@web/ui/popover';
import { Progress } from '@web/ui/progress';
import { RadioGroup, RadioGroupItem } from '@web/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@web/ui/select';
import { Separator } from '@web/ui/separator';
import { Skeleton } from '@web/ui/skeleton';
import { Spinner } from '@web/ui/spinner';
import { STATUS_KINDS, StatusIcon } from '@web/ui/status-icon';
import { Switch } from '@web/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@web/ui/tabs';
import { Textarea } from '@web/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@web/ui/toggle-group';
import { TooltipProvider } from '@web/ui/tooltip';
import { navigationDemos } from './navigation-demos';
import { PlaygroundScenario } from './PlaygroundScenario';
import { SCENARIOS, type ScenarioId } from './scenarios';
import type { PlaygroundDemo } from './types';

/** Developer labels of the gallery (no product UI text; real strings come from t()). */
const SAMPLE = {
  variants: ['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const,
  badges: ['default', 'secondary', 'outline', 'success', 'warning', 'info', 'destructive'] as const,
  gauge: [12, 72, 91] as const,
  modes: ['default', 'acceptEdits', 'plan', 'auto'] as const,
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-2">
      <h2 className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">{title}</h2>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </section>
  );
}

function StatusGallery() {
  return (
    <TooltipProvider>
      <div className="grid max-w-3xl grid-cols-2 gap-x-8 gap-y-2 p-6">
        {STATUS_KINDS.map((kind) => (
          <div key={kind} className="flex items-center justify-between gap-4 border-b py-1">
            <StatusIcon kind={kind} showLabel />
            <code className="text-muted-foreground text-2xs">{kind}</code>
          </div>
        ))}
      </div>
    </TooltipProvider>
  );
}

function PrimitivesGallery() {
  const { t, tError } = useI18n();
  const [checked, setChecked] = useState(true);
  const [toggle, setToggle] = useState<string>('session');
  return (
    <TooltipProvider>
      <div className="grid max-w-4xl gap-6 p-6">
        <Section title="Button">
          {SAMPLE.variants.map((variant) => (
            <Button key={variant} variant={variant}>
              {variant}
            </Button>
          ))}
          <Button size="sm">{t('common.retry')}</Button>
          <Button disabled>{t('common.loading')}</Button>
          <IconButton label={t('settings.label')}>
            <SettingsIcon aria-hidden />
          </IconButton>
          <IconButton label={t('common.dismiss')} variant="outline" size="icon">
            <TrashIcon aria-hidden />
          </IconButton>
        </Section>
        <Section title="Badge · Kbd · Spinner">
          {SAMPLE.badges.map((variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ))}
          <KbdGroup keys={['Alt', '1']} />
          <KbdGroup keys={['?']} />
          <Spinner />
        </Section>
        <Section title="Gauge · Progress · Skeleton">
          {SAMPLE.gauge.map((value) => (
            <Gauge key={value} value={value} label={t('shell.session.context')} />
          ))}
          <Progress value={40} aria-label={t('common.loading')} className="w-40" />
          <Skeleton className="h-4 w-32" />
        </Section>
        <Section title="Input · Textarea · Select">
          <div className="grid w-64 gap-1.5">
            <Label htmlFor="pg-input">{t('newSession.cwd.label')}</Label>
            <Input id="pg-input" placeholder={t('newSession.cwd.placeholder')} />
          </div>
          <Textarea className="w-72" placeholder={t('shell.placeholders.composer')} />
          <Select defaultValue="acceptEdits">
            <SelectTrigger aria-label={t('shell.session.permissionMode')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SAMPLE.modes.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`shell.permissionMode.${mode}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>
        <Section title="Checkbox · Radio · Switch · ToggleGroup">
          <Label>
            <Checkbox
              checked={checked}
              onCheckedChange={(value) => {
                setChecked(value === true);
              }}
            />
            {t('settings.shortcuts')}
          </Label>
          <RadioGroup defaultValue="dark" className="flex gap-3" aria-label={t('settings.theme')}>
            <Label>
              <RadioGroupItem value="dark" />
              {t('settings.themes.dark')}
            </Label>
            <Label>
              <RadioGroupItem value="light" />
              {t('settings.themes.light')}
            </Label>
          </RadioGroup>
          <Switch aria-label={t('settings.shortcuts')} defaultChecked />
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={toggle}
            onValueChange={(value) => {
              if (value !== '') setToggle(value);
            }}
            aria-label={t('settings.theme')}
          >
            <ToggleGroupItem value="session">{t('settings.themes.dark')}</ToggleGroupItem>
            <ToggleGroupItem value="local">{t('settings.themes.light')}</ToggleGroupItem>
            <ToggleGroupItem value="system">{t('settings.themes.system')}</ToggleGroupItem>
          </ToggleGroup>
        </Section>
        <Section title="Tabs · Card · Separator">
          <Tabs defaultValue="a" className="w-80">
            <TabsList>
              <TabsTrigger value="a">{t('settings.theme')}</TabsTrigger>
              <TabsTrigger value="b">{t('settings.language')}</TabsTrigger>
            </TabsList>
            <TabsContent value="a" className="text-muted-foreground text-xs">
              {t('shell.empty.description')}
            </TabsContent>
            <TabsContent value="b" className="text-muted-foreground text-xs">
              {t('settings.languages.de')}
            </TabsContent>
          </Tabs>
          <Card className="w-72">
            <CardHeader>
              <CardTitle>{t('newSession.title')}</CardTitle>
              <CardDescription>{t('shell.empty.welcomeDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              <Separator className="my-2" />
              <Button size="sm">
                <PlusIcon aria-hidden />
                {t('newSession.submit')}
              </Button>
            </CardContent>
          </Card>
        </Section>
        <Section title="Alert · Banner">
          <div className="grid w-full gap-2">
            <Alert tone="info" title={t('shell.setup.title')}>
              {t('shell.setup.description')}
            </Alert>
            <Alert tone="error" title={t('shell.session.unavailable')}>
              {tError(makeError('ENTRY_NOT_FOUND'))}
            </Alert>
            <Banner
              tone="warning"
              actions={
                <Button size="sm" variant="ghost">
                  {t('common.retryNow')}
                </Button>
              }
            >
              {t('connection.reconnecting')}
            </Banner>
          </div>
        </Section>
        <Section title="DropdownMenu · Popover · Dialog · Tooltip">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">{t('settings.label')}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>
                <CopyIcon aria-hidden />
                {t('shell.session.sessionId')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">
                <TrashIcon aria-hidden />
                {t('common.dismiss')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline">{t('navigation.actions.sessionInfo')}</Button>
            </PopoverTrigger>
            <PopoverContent className="text-xs">{t('shell.empty.description')}</PopoverContent>
          </Popover>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">{t('shell.shortcuts.title')}</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t('shell.shortcuts.title')}</DialogTitle>
                <DialogDescription>{t('shell.shortcuts.description')}</DialogDescription>
              </DialogHeader>
            </DialogContent>
          </Dialog>
        </Section>
      </div>
    </TooltipProvider>
  );
}

function shellDemo(scenario: ScenarioId): PlaygroundDemo {
  return {
    id: `shell-${scenario}`,
    title: `Shell – ${SCENARIOS[scenario].title}`,
    render: () => (
      <PlaygroundScenario scenario={scenario}>
        <AppShell />
      </PlaygroundScenario>
    ),
  };
}

/** WP-14's own demos (feature demos are discovered from src/web/features/*\/playground.tsx). */
export const shellDemos: readonly PlaygroundDemo[] = [
  shellDemo('overview'),
  shellDemo('streaming'),
  shellDemo('decisions'),
  shellDemo('empty'),
  shellDemo('setup'),
  shellDemo('checking'),
  shellDemo('offline'),
  shellDemo('signed-out'),
  shellDemo('outdated'),
  ...navigationDemos,
  {
    id: 'ui-status-icons',
    title: 'UI – Status icons (all display statuses)',
    render: () => <StatusGallery />,
  },
  { id: 'ui-primitives', title: 'UI – Primitives', render: () => <PrimitivesGallery /> },
];
