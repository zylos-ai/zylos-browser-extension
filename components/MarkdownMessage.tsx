import { memo, useId } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from './LanguageProvider';

function messageUrl(value: string, key: string): string | undefined {
  if (key === 'href' && value.startsWith('#')) return value;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (
      ['http:', 'https:'].includes(url.protocol) ||
      (key === 'href' && url.protocol === 'mailto:')
    )
      return url.href;
  } catch {
    /* Relative URLs have no website base inside the extension. */
  }
  return undefined;
}

// Render from the saved source on demand, including older replies. Memoization
// keeps browser step updates from reparsing unchanged Markdown in the history.
export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="message-text markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{
          clobberPrefix: `message-${id}-`,
          footnoteLabel: t('markdownFootnotes'),
          footnoteBackLabel: t('markdownFootnoteBack'),
        }}
        skipHtml
        urlTransform={messageUrl}
        components={{
          a: ({ node: _node, href, children, ...props }) =>
            href ? (
              <a
                {...props}
                href={href}
                target={href.startsWith('#') ? undefined : '_blank'}
                rel="noopener noreferrer"
                onClick={
                  href.startsWith('#')
                    ? (event) => {
                        // Keep the sidepanel URL stable: its background messages are
                        // authenticated against the exact bundled page URL.
                        event.preventDefault();
                        try {
                          const target = document.getElementById(decodeURIComponent(href.slice(1)));
                          if (
                            target &&
                            event.currentTarget.closest('.markdown-body')?.contains(target)
                          ) {
                            target.scrollIntoView({ block: 'nearest' });
                            target.focus({ preventScroll: true });
                          }
                        } catch {
                          /* An invalid fragment remains inert. */
                        }
                      }
                    : undefined
                }
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ node: _node, src, alt, ...props }) =>
            src ? (
              <img
                {...props}
                src={src}
                alt={alt ?? ''}
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span>{alt}</span>
            ),
          table: ({ node: _node, ...props }) => (
            <div
              className="markdown-table-scroll"
              role="region"
              aria-label={t('markdownTable')}
              tabIndex={0}
            >
              <table {...props} />
            </div>
          ),
          pre: ({ node: _node, ...props }) => (
            <pre {...props} tabIndex={0} aria-label={t('markdownCode')} />
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
});
