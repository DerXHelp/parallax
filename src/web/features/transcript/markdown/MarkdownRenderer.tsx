import { ImageIcon } from 'lucide-react';
import {
  createContext,
  memo,
  useContext,
  useMemo,
  type ComponentProps,
  type JSX,
  type ReactNode,
} from 'react';
import ReactMarkdown, { type Components, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useT } from '@web/i18n';
import { cn } from '@web/lib/cn';
import { CodeBlock } from '../components/CodeBlock';
import { resolveLanguage } from '../lib/languages';
import { splitMarkdownBlocks } from '../lib/markdown-blocks';
import { markdownUrlTransform, safeHttpUrl } from '../lib/safe-url';
import { preserveWindowsPaths } from '../lib/windows-paths';

/**
 * The heavy part of the Markdown renderer (lazy chunk). Security (Review C.10, CLAUDE.md):
 * react-markdown without rehype-raw and with `skipHtml` – raw HTML is dropped, never rendered;
 * `urlTransform` + the link/image renderers only allow absolute http(s) URLs; images never load
 * (CSP `img-src 'self'` blocks remote images anyway) but become links. Performance: the text is
 * split into blocks, each block is a memoized `ReactMarkdown` – while streaming only the last
 * block is parsed again (B "Speicher und Performance").
 */

const REMARK_PLUGINS = [remarkGfm];

/** The current block ends in an unclosed fence (no highlighting until it closes). */
const OpenFenceContext = createContext(false);
/** `code` inside `pre` is a code block, otherwise inline code. */
const InPreContext = createContext(false);

function textOf(children: ReactNode): string {
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map((child: ReactNode) => textOf(child)).join('');
  return '';
}

type Props<K extends keyof JSX.IntrinsicElements> = ComponentProps<K> & ExtraProps;

function Code({ className, children }: Props<'code'>) {
  const inPre = useContext(InPreContext);
  const openFence = useContext(OpenFenceContext);
  if (!inPre) {
    return <code className="bg-muted rounded-sm px-1 py-px font-mono text-[0.85em]">{children}</code>;
  }
  const info = /(?:^|\s)language-(\S+)/.exec(className ?? '')?.[1] ?? null;
  const code = textOf(children).replace(/\n$/, '');
  return (
    <CodeBlock
      code={code}
      language={resolveLanguage(info)}
      label={info}
      highlight={!openFence}
      className="my-2"
    />
  );
}

function Pre({ children }: Props<'pre'>) {
  return <InPreContext value={true}>{children}</InPreContext>;
}

function Link({ href, children }: Props<'a'>) {
  const t = useT();
  const url = safeHttpUrl(href);
  if (url === null) {
    return (
      <span
        data-blocked-link=""
        title={t('transcript.markdown.blockedLink')}
        className="decoration-muted-foreground underline decoration-dotted underline-offset-2"
      >
        {children}
      </span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={t('transcript.markdown.externalLink', { url })}
      className="text-brand underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

/** Images never load; a safe source becomes a link, otherwise only the alt text remains. */
function Image({ src, alt }: Props<'img'>) {
  const t = useT();
  const url = safeHttpUrl(typeof src === 'string' ? src : null);
  const label =
    alt === undefined || alt === ''
      ? t('transcript.markdown.imageNoAlt')
      : t('transcript.markdown.image', { alt });
  const content = (
    <>
      <ImageIcon aria-hidden className="size-3.5" />
      {label}
    </>
  );
  if (url === null) {
    return (
      <span className="text-muted-foreground inline-flex items-center gap-1 align-middle">{content}</span>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={t('transcript.markdown.externalLink', { url })}
      className="text-brand inline-flex items-center gap-1 align-middle underline-offset-2 hover:underline"
    >
      {content}
    </a>
  );
}

function Input({ type, checked }: Props<'input'>) {
  if (type !== 'checkbox') return null;
  return (
    <input type="checkbox" checked={checked === true} readOnly disabled className="mr-1.5 align-middle" />
  );
}

const heading = 'mt-3 mb-1.5 font-semibold first:mt-0';

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  a: Link,
  img: Image,
  code: Code,
  pre: Pre,
  input: Input,
  h1: ({ children }) => <h1 className={cn(heading, 'text-base')}>{children}</h1>,
  h2: ({ children }) => <h2 className={cn(heading, 'text-[0.95rem]')}>{children}</h2>,
  h3: ({ children }) => <h3 className={cn(heading, 'text-sm')}>{children}</h3>,
  h4: ({ children }) => <h4 className={cn(heading, 'text-ui')}>{children}</h4>,
  h5: ({ children }) => <h5 className={cn(heading, 'text-ui')}>{children}</h5>,
  h6: ({ children }) => <h6 className={cn(heading, 'text-muted-foreground text-ui')}>{children}</h6>,
  ul: ({ children, className }) => (
    <ul
      className={cn(
        'my-2 pl-5 first:mt-0 last:mb-0',
        className?.includes('contains-task-list') === true ? 'list-none pl-1' : 'list-disc',
      )}
    >
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol start={start} className="my-2 list-decimal pl-5 first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="my-0.5 pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="text-muted-foreground my-2 border-l-2 pl-3">{children}</blockquote>
  ),
  hr: () => <hr className="my-3" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-max max-w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children, style }) => (
    <th style={style} className="bg-muted/50 border px-2 py-1 text-left font-semibold">
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td style={style} className="border px-2 py-1 align-top">
      {children}
    </td>
  ),
};

const MarkdownBlockView = memo(function MarkdownBlockView({
  text,
  openFence,
}: {
  text: string;
  openFence: boolean;
}) {
  return (
    <OpenFenceContext value={openFence}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        skipHtml
        urlTransform={markdownUrlTransform}
        components={COMPONENTS}
      >
        {text}
      </ReactMarkdown>
    </OpenFenceContext>
  );
});

export function MarkdownRenderer({ text, streaming }: { text: string; streaming: boolean }) {
  // V2-12: backslashes of Windows paths in running text stay visible (`\.` is no escape there).
  const blocks = useMemo(() => splitMarkdownBlocks(preserveWindowsPaths(text)), [text]);
  return blocks.map((block, index) => (
    <MarkdownBlockView key={index} text={block.text} openFence={streaming && block.openFence} />
  ));
}
