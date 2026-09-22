import type { PageSelection } from '../utils/page-selection';
import { useI18n } from './LanguageProvider';

export function SelectionQuote({
  selection,
  onRemove,
}: {
  selection: PageSelection;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  return (
    <aside className="selection-quote" aria-label={t('selectedText')}>
      <div className="selection-quote-heading">
        <span className="selection-quote-label">{t('selectedText')}</span>
        <span className="selection-quote-source" title={selection.url}>
          {selection.title || selection.url}
        </span>
        {onRemove && (
          <button
            type="button"
            className="btn btn-ghost selection-quote-remove"
            onClick={onRemove}
            aria-label={t('removeSelection')}
            title={t('removeSelection')}
          >
            ×
          </button>
        )}
      </div>
      <blockquote>{selection.text}</blockquote>
      {selection.truncated && <p className="selection-quote-note">{t('selectionTruncated')}</p>}
    </aside>
  );
}
