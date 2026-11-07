/**
 * Guides: static pages at /guides/<slug>/, built from the template in
 * render.tsx by scripts/build-static.mjs.
 *
 * A guide is listed in sitemap.xml and linked from the home page only once it
 * is `published`. An unpublished one is still built, so its page can be
 * checked, but carries noindex and is linked from nowhere.
 *
 * `body` and `forIT` are HTML written here, in the repository, by us: they are
 * trusted, and go into the page as written.
 */
import type { StaticPage } from "./pages";

export interface Guide {
  /** The address: /guides/<slug>/. Lower case, digits and hyphens. */
  slug: string;
  title: string;
  description: string;
  published: boolean;
  body: string;
  /** Extra lines for the "For IT" section, ahead of the standard ones. */
  forIT?: string;
}

/**
 * The template's own test page, not a guide. Unpublished, so it never reaches
 * the sitemap or a search engine. The guides themselves are still to be
 * written.
 */
export const PLACEHOLDER_GUIDE: Guide = {
  slug: "template-check",
  title: "Guide template check",
  description: "A placeholder that exercises the guide template. Not a guide.",
  published: false,
  body: "<p>This page exists to test the guide template. The guides are still to be written.</p>",
};

export const GUIDES: Guide[] = [PLACEHOLDER_GUIDE];

export const publishedGuides = (guides: Guide[] = GUIDES) => guides.filter((g) => g.published);

export function guidePage(guide: Guide): StaticPage {
  return {
    path: `/guides/${guide.slug}/`,
    title: `${guide.title} · Mailviewer`,
    description: guide.description,
    ogType: "article",
  };
}
