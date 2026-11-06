import { Footer } from "./Footer";

/**
 * The #/terms page (MAC-787): the terms of the free web app, which has none
 * beyond these. The terms of sale and the refund policy for a Mailviewer for
 * Mac license are published once, with the app's privacy notes, on the Mac
 * release host (TERMS.md in machinery-software/mailviewer-mac); this page and
 * the purchase page's footer point there rather than carry a copy (David,
 * 6 November: one text, not two).
 */
export const MAC_TERMS_URL = "https://updates.mailviewer.app/terms/";

export default function Terms() {
  return (
    <>
      <section className="section section-narrow">
        <h2>Terms</h2>
        <h3>The web app is free, and these are its terms</h3>
        <p>
          The viewer on this site has no account, no license and no fee. What follows is all it
          asks of you, and all it promises. The terms for buying Mailviewer for Mac are a separate
          page, below.
        </p>

        <div className="prose-block">
          <h4>Provided as is</h4>
          <p>
            The viewer reads your files on your own device and shows them to you. It is provided as
            is, without warranty of any kind: if a file does not open, or opens wrongly, that is a
            bug to <a href="#/report">report</a>, not a claim against Machinery Software LLC. We are
            not liable for any loss arising from your use of it, to the extent the law allows.
          </p>

          <h4>Your files are yours</h4>
          <p>
            Nothing you open is sent to us or to anyone else; the page is served with a policy that
            makes that impossible for the browser to do, and you can{" "}
            <a href="#/verify">check it yourself</a>. The <a href="#/privacy">privacy page</a> says
            exactly what the site does and does not do.
          </p>

          <h4>Open source</h4>
          <p>
            The source is public under the MIT license. You may read it, run your own copy, and
            change it, on the terms of that license.
          </p>

          <h4>Acceptable use</h4>
          <p>
            Use it to read mail you are entitled to read. Do not use it to attack this site or
            anyone else's; the site has no server to attack, but the sentence belongs here.
          </p>

          <h4>Changes</h4>
          <p>
            If these terms change, the change is published here and in the source repository's
            history, and applies from then on.
          </p>
        </div>

        <div className="prose-block">
          <h4>Mailviewer for Mac</h4>
          <p>
            The terms of sale, the refund policy and the privacy notes for a Team, Business or Site
            license, and for the app itself, are published with its downloads:{" "}
            <a href={MAC_TERMS_URL} target="_blank" rel="noopener noreferrer">
              updates.mailviewer.app/terms
            </a>
            . The Personal license is sold by Apple through the Mac App Store, under Apple's terms.
          </p>
        </div>
      </section>
      <Footer note="Questions about these terms: the contact page has the addresses." />
    </>
  );
}
