/** Where the public source lives. Referenced from the nav, footer and privacy page. */
export const SOURCE_URL = "https://github.com/mactesting12/mailviewer";

/** The company that maintains this free tool, linked from the footer of every page. */
export const COMPANY_NAME = "Machinery Software";
export const COMPANY_URL = "https://machinery.software";

/** Where bug reports go. Both routes are deliberate; see src/lib/report.ts. */
export const SUPPORT_EMAIL = "support@mailviewer.app";
export const ISSUES_URL = `${SOURCE_URL}/issues`;

/**
 * Which build this is. Stamped in by Vite at build time so a report can be tied
 * to an exact bundle -- the app cannot ask a server what version it is running,
 * because it cannot ask a server anything.
 */
export const BUILD = { version: __APP_VERSION__, commit: __APP_COMMIT__ };
