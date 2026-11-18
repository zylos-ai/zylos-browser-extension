import { useId, useState, type ReactNode } from 'react';
import { useI18n } from './LanguageProvider';

/** A titled group of rows rendered as one bordered list. */
export function SettingsGroup({
  id,
  title,
  className = '',
  children,
}: {
  id: string;
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`settings-group ${className}`} aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      <div className="settings-list">{children}</div>
    </section>
  );
}

/**
 * One row: short label + at most one muted line on the left, a control on the right.
 * Long explanations stay behind a small info toggle.
 */
export function SettingsItem({
  label,
  labelId,
  htmlFor,
  hint,
  hintId,
  more,
  control,
  className = '',
}: {
  label: ReactNode;
  labelId?: string;
  htmlFor?: string;
  hint?: ReactNode;
  hintId?: string;
  more?: string;
  control?: ReactNode;
  className?: string;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const moreId = useId();
  return (
    <div className={`settings-item ${className}`}>
      <div className="settings-item-main">
        <div className="settings-item-copy">
          <span className="settings-item-label">
            <label id={labelId} htmlFor={htmlFor}>
              {label}
            </label>
            {more && (
              <button
                type="button"
                className="settings-info"
                aria-label={t('learnMore')}
                title={t('learnMore')}
                aria-expanded={open}
                aria-controls={moreId}
                onClick={() => setOpen((v) => !v)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 11v5M12 8h.01" />
                </svg>
              </button>
            )}
          </span>
          {hint && (
            <p id={hintId} className="settings-item-hint">
              {hint}
            </p>
          )}
        </div>
        {control}
      </div>
      {more && open && (
        <p id={moreId} className="settings-item-more">
          {more}
        </p>
      )}
    </div>
  );
}

/** Row that navigates (to a sub-page or another view). */
export function SettingsLink({
  className = '',
  leading,
  label,
  hint,
  value,
  onClick,
}: {
  className?: string;
  leading?: ReactNode;
  label: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`settings-item settings-link ${className}`} onClick={onClick}>
      <span className="settings-item-main">
        {leading}
        <span className="settings-item-copy">
          <span className="settings-item-label">{label}</span>
          {hint && <span className="settings-item-hint">{hint}</span>}
        </span>
        {value !== undefined && <span className="settings-item-value">{value}</span>}
        <svg
          className="settings-chevron"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </span>
    </button>
  );
}

export function Switch({
  id,
  checked,
  labelledBy,
  describedBy,
  disabled,
  onClick,
}: {
  id: string;
  checked: boolean;
  labelledBy: string;
  describedBy?: string;
  disabled?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      id={id}
      className="connection-toggle"
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="settings-switch-track" aria-hidden="true">
        <span />
      </span>
    </button>
  );
}
