import { useState } from 'react';
import type { MemoryFileKind } from '@shared/model';
import { useFormat } from '@web/i18n';
import { useFeatureSlots } from '@web/shell/slots';
import { useNow } from '@web/state/clock';
import { Alert } from '@web/ui/alert';
import { Badge } from '@web/ui/badge';
import { CopyButton } from '@web/ui/copy-button';
import { Switch } from '@web/ui/switch';
import { useInfoT, type InfoKey } from './i18n';
import { ExtraRows, SectionFrame, TruncatedNote } from './SectionFrame';
import { useSessionInfo } from './use-session-info';

const KIND_KEY: Readonly<Record<MemoryFileKind, InfoKey>> = {
  user: 'memory.kinds.user',
  project: 'memory.kinds.project',
  'project-alt': 'memory.kinds.projectAlt',
  local: 'memory.kinds.local',
  other: 'memory.kinds.unknown',
};

/** A path as a file link (only once the file exists – `verify`) plus "copy path". */
function PathLine({
  sessionKey,
  path,
  onCopied,
}: {
  sessionKey: string;
  path: string;
  onCopied: (ok: boolean) => void;
}) {
  const { FileLink } = useFeatureSlots();
  const it = useInfoT();
  return (
    <div className="flex min-w-0 items-center gap-1">
      <span className="min-w-0 font-mono text-2xs break-all">
        <FileLink sessionKey={sessionKey} path={path} verify variant="inline">
          {path}
        </FileLink>
      </span>
      <CopyButton text={path} label={it('memory.copyPath')} onCopied={onCopied} className="shrink-0" />
    </div>
  );
}

/** One of the two switches of `/memory`, shown only (Parallax never writes the CLI's settings). */
function SwitchRow({ label, enabled, status }: { label: string; enabled: boolean; status: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <Switch checked={enabled} disabled aria-label={label} />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">{status}</span>
    </div>
  );
}

/**
 * CLAUDE.md tab (WP-67): the instruction files with their level (user, project, local, other),
 * each path as a file link with "copy path", the memory folders, saved memories and the auto
 * memory / auto dream switches (display only).
 */
export function MemoryTab({ sessionKey }: { sessionKey: string }) {
  const it = useInfoT();
  const format = useFormat();
  const now = useNow(60_000);
  const [copyFailed, setCopyFailed] = useState(false);
  const onCopied = (ok: boolean): void => {
    setCopyFailed(!ok);
  };
  const query = useSessionInfo(sessionKey, 'memory');

  return (
    <SectionFrame query={query}>
      {(data) => (
        <div className="grid gap-4">
          {copyFailed ? <Alert tone="error">{it('memory.copyFailed')}</Alert> : null}
          {data.files.length === 0 && data.folders.length === 0 && data.memories.length === 0 ? (
            <p className="text-muted-foreground text-xs">{it('memory.empty')}</p>
          ) : null}
          {data.files.length === 0 ? null : (
            <section className="grid gap-1.5" data-slot="memory-files">
              <h3 className="text-sm font-medium">{it('memory.files')}</h3>
              <ul className="grid gap-2">
                {data.files.map((file) => (
                  <li
                    key={file.path}
                    className="grid gap-0.5 rounded-md border px-3 py-2"
                    data-kind={file.kind}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">{it(KIND_KEY[file.kind])}</Badge>
                      <span className="text-xs font-medium">{file.label}</span>
                      {file.exists ? null : <Badge variant="outline">{it('memory.missing')}</Badge>}
                    </div>
                    {file.description === '' ? null : (
                      <p className="text-muted-foreground text-2xs">{file.description}</p>
                    )}
                    <PathLine sessionKey={sessionKey} path={file.path} onCopied={onCopied} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.folders.length === 0 ? null : (
            <section className="grid gap-1.5" data-slot="memory-folders">
              <h3 className="text-sm font-medium">{it('memory.folders')}</h3>
              <ul className="grid gap-1.5">
                {data.folders.map((folder) => (
                  <li key={folder.path} className="grid gap-0.5">
                    <span className="text-xs">{folder.label}</span>
                    <PathLine sessionKey={sessionKey} path={folder.path} onCopied={onCopied} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.memories.length === 0 ? null : (
            <section className="grid gap-1.5" data-slot="memory-memories">
              <h3 className="text-sm font-medium">{it('memory.memories')}</h3>
              <ul className="grid gap-1.5">
                {data.memories.map((memory) => (
                  <li key={memory.path} className="grid gap-0.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-medium">{memory.name}</span>
                      {memory.type === null ? null : <Badge variant="outline">{memory.type}</Badge>}
                      {memory.modifiedAt === null ? null : (
                        <span className="text-muted-foreground text-2xs">
                          {it('memory.modified', { time: format.relative(memory.modifiedAt, now) })}
                        </span>
                      )}
                    </div>
                    {memory.description === null ? null : (
                      <p className="text-muted-foreground text-2xs">{memory.description}</p>
                    )}
                    <PathLine sessionKey={sessionKey} path={memory.path} onCopied={onCopied} />
                  </li>
                ))}
              </ul>
            </section>
          )}
          {data.autoMemory === null && data.autoDream === null ? null : (
            <section className="grid gap-1.5" data-slot="memory-switches">
              {data.autoMemory === null ? null : (
                <SwitchRow
                  label={it('memory.autoMemory')}
                  enabled={data.autoMemory.enabled}
                  status={data.autoMemory.status}
                />
              )}
              {data.autoDream?.shown === true ? (
                <SwitchRow
                  label={it('memory.autoDream')}
                  enabled={data.autoDream.enabled}
                  status={data.autoDream.status}
                />
              ) : null}
              <p className="text-muted-foreground text-2xs">{it('memory.readOnly')}</p>
            </section>
          )}
          <TruncatedNote truncated={data.truncated} />
          <ExtraRows rows={data.extra} />
        </div>
      )}
    </SectionFrame>
  );
}
