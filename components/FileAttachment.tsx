export function FileAttachment({
  name,
  bytes,
  compact = false,
}: {
  name: string;
  bytes: number;
  compact?: boolean;
}) {
  const size =
    bytes < 1000
      ? `${bytes} B`
      : bytes < 1_000_000
        ? `${(bytes / 1000).toFixed(1)} KB`
        : `${(bytes / 1_000_000).toFixed(2)} MB`;
  return (
    <span
      className={`file-attachment${compact ? ' is-compact' : ''}`}
      title={`${name} · ${size}`}
      role={compact ? 'img' : undefined}
      aria-label={compact ? name : undefined}
    >
      <svg
        width="20"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
        <path d="M14 2v6h6M8 13h8M8 17h5" />
      </svg>
      {!compact && (
        <span className="file-attachment-info">
          <span className="file-attachment-name">{name}</span>
          <span className="file-attachment-size">{size}</span>
        </span>
      )}
    </span>
  );
}
