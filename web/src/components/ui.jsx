export function Badge({ tone = 'neutral', variant = 'solid', title, children }) {
  return (
    <span className={`badge badge-${tone} badge-${variant}`} title={title}>
      {children}
    </span>
  );
}

export function Panel({ title, id, aside, children, className = '' }) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section className={`panel ${className}`} aria-labelledby={headingId}>
      {(title || aside) && (
        <header className="panel-head">
          {title && <h2 id={headingId} className="panel-title">{title}</h2>}
          {aside && <div className="panel-aside">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function KeyValue({ label, children, mono = false }) {
  return (
    <div className="kv">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </div>
  );
}

export function Dot({ state }) {
  return <span className={`dot dot-${state}`} aria-hidden="true" />;
}

export function Notice({ tone = 'neutral', title, children }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'danger' ? 'alert' : 'note'}>
      {title && <strong>{title}</strong>}
      <div>{children}</div>
    </div>
  );
}

const PATHS = {
  logo: 'M12 2.5 3.5 7v6.2c0 4.3 3.4 7.4 8.5 8.3 5.1-.9 8.5-4 8.5-8.3V7L12 2.5Zm0 5.2 4.4 2.4v3.2c0 2.2-1.7 3.8-4.4 4.5-2.7-.7-4.4-2.3-4.4-4.5v-3.2L12 7.7Z',
  open: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h4l2 2.5h7A1.5 1.5 0 0 1 20 8v9.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5v-12Z',
  overview: 'M4 4h7v7H4V4Zm9 0h7v4h-7V4ZM4 13h7v7H4v-7Zm9-3h7v10h-7V10Z',
  files: 'M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm6 1.5V9h4.5L13 4.5Z',
  findings: 'M12 3 2.5 20h19L12 3Zm-1 6h2v6h-2V9Zm0 8h2v2h-2v-2Z',
  ai: 'M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3Zm6 10 .9 2.1 2.1.9-2.1.9L18 19l-.9-2.1-2.1-.9 2.1-.9L18 13Z',
  chevron: 'm9 6 6 6-6 6',
};
export function Icon({ name, size = 16 }) {
  const stroke = name === 'chevron';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill={stroke ? 'none' : 'currentColor'} stroke={stroke ? 'currentColor' : 'none'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} fillRule="evenodd" />
    </svg>
  );
}
