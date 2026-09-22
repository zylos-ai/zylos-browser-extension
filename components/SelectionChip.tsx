import { useId, useState } from 'react';
import type { PageSelection } from '../utils/page-selection';
import { useI18n } from './LanguageProvider';
import { SelectionQuote } from './SelectionQuote';

export function SelectionChip({
  selection,
  faviconUrl,
  onRemove,
}: {
  selection: PageSelection;
  faviconUrl?: string;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [failedIcon, setFailedIcon] = useState<string>();
  const icon =
    faviconUrl && /^(https?:|data:image\/)/i.test(faviconUrl) && faviconUrl !== failedIcon
      ? faviconUrl
      : undefined;
  return (
    <div
      className="selection-chip-row"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <div
        className="selection-chip"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
        }}
      >
        <button
          type="button"
          className="selection-chip-label"
          aria-label={`${t('selectedText')} · ${selection.title || selection.url}`}
          aria-describedby={open ? tooltipId : undefined}
          onClick={() => setOpen(true)}
        >
          {icon ? (
            <img
              className="selection-chip-icon"
              src={icon}
              width="16"
              height="16"
              alt=""
              referrerPolicy="no-referrer"
              onError={() => setFailedIcon(icon)}
            />
          ) : (
            <svg
              className="selection-chip-icon"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
              <path d="M14 3v6h6M8 13h8M8 17h6" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="btn btn-ghost selection-quote-remove"
          onClick={onRemove}
          aria-label={t('removeSelection')}
          title={t('removeSelection')}
        >
          ×
        </button>
        <div id={tooltipId} role="tooltip" className="selection-tooltip" hidden={!open}>
          <SelectionQuote selection={selection} />
        </div>
      </div>
    </div>
  );
}
