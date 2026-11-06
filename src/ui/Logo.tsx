/**
 * The one Mailviewer mark, shared with the Mac purchase page
 * (public/mac/index.html), the Mac release host and public/favicon.svg
 * (MAC-787: one logo across the site and the Mac pages).
 */
export function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="mv-logo-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6FE4CB" />
          <stop offset="1" stopColor="#2FB89C" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="32" height="32" rx="8" fill="url(#mv-logo-gradient)" />
      <rect x="6" y="9" width="17" height="12" rx="2" fill="#FFFFFF" />
      <path d="M6.5 10 L14.5 16 L22.5 10" fill="none" stroke="#1F6F62" strokeWidth="1.6" />
      <circle cx="21" cy="19.5" r="4.2" fill="none" stroke="#FFFFFF" strokeWidth="1.8" />
      <path d="M24 22.5 L27 25.5" stroke="#FFFFFF" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
