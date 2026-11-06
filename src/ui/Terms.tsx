import { SALES_EMAIL, SECURITY_EMAIL, SUPPORT_EMAIL } from "../config";
import { Footer } from "./Footer";

/**
 * The #/terms page (MAC-787, closing MAC-740): the terms of sale and the
 * refund policy for a Mailviewer for Mac license bought online, and what the
 * free web app's terms are.
 *
 * The Mac text is TERMS.md in machinery-software/mailviewer-mac, as published
 * at https://updates.mailviewer.app/terms/ (last updated November 4, 2026),
 * carried here word for word so that the footer's Terms link on the purchase
 * page lands on the terms a buyer is agreeing to. Change the two together.
 */
const UPDATED = "November 4, 2026";

export default function Terms() {
  return (
    <>
      <section className="section section-narrow">
        <h2>Terms</h2>
        <h3>Terms of sale, refunds, and what this site asks of you</h3>
        <p>
          The terms of sale for a Mailviewer for Mac license bought online, the refund policy, and
          the terms of the free web app. Last updated {UPDATED}.
        </p>

        <div className="prose-block" id="sale">
          <h4>Terms of sale: Mailviewer for Mac</h4>
          <p>
            These terms apply when you buy a Team, Business or Site license for Mailviewer for Mac
            online from Machinery Software LLC, a Michigan limited liability company ("we"). If your
            organization signs a master software agreement with us, that agreement replaces these
            terms for the licenses it covers.
          </p>
          <ol className="clauses">
            <li>
              <b>What you're buying.</b> A one-year license to install and use Mailviewer for Mac on
              up to the number of Macs on your order (any number, for a Site license), for the
              people in your organization. You get one license key for your whole organization, all
              updates released during the year, and email support. The key is yours to install on
              your organization's Macs; don't publish it or give it to anyone outside your
              organization.
            </li>
            <li>
              <b>The license.</b> The license is non-exclusive and non-transferable. You may install
              the app on the number of Macs you paid for. You may not resell or sublicense it,
              remove its notices, or reverse engineer it beyond what the law allows. We and our
              licensors keep all rights in the software. You own your email files; we never see
              them.
            </li>
            <li>
              <b>Seats.</b> If you install on more Macs than you paid for, buy the extra seats
              within 30 days at the per-Mac price on the pricing page. We don't count installs and
              have no way to; this is on your honor and your contract.
            </li>
            <li>
              <b>Price and payment.</b> The price is the one shown at checkout, in US dollars, for
              one year, paid in advance. Card purchases are processed by Stripe as the merchant of
              record: Stripe charges you, collects and remits any sales tax, VAT or GST, and issues
              your receipt, and Stripe's purchase terms govern the payment. These terms govern the
              license. If your organization can't pay by card, we can issue an invoice instead, due
              in 30 days; email <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a>.
            </li>
            <li>
              <b>Renewal.</b> Your license renews automatically each year, and the card on file is
              charged the then-current price unless you cancel first. You'll get a reminder email at
              least 15 days before each renewal, and you can cancel at any time before it from the
              link in your receipt or by emailing <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a>;
              the license then runs to the end of the paid year. The renewal price won't rise more
              than 5% a year for an existing customer. Each renewal emails you a new key. If a
              license lapses, the app keeps working for 14 days, then becomes an evaluation copy:
              single messages and Quick Look work as before, and mailbox windows show their first 25
              messages until a valid key is installed.
            </li>
            <li>
              <b>Support.</b> Email support at <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
              Team: a reply within 2 business days. Business and Site: a reply within 1 business day.
              We support the current and previous major versions of macOS and give 90 days' notice
              before dropping one.
            </li>
            <li>
              <b>Security.</b> We keep the app signed and notarized by Apple. The parts of the app
              that read your messages have no network access; the only network activity is the
              update check described in the app's privacy notes, which you can turn off. If we
              become aware of a security vulnerability that affects you, we'll tell you within 48
              hours and provide a fix or workaround as soon as reasonably practical. Our security
              contact is <a href={`mailto:${SECURITY_EMAIL}`}>{SECURITY_EMAIL}</a>.
            </li>
            <li>
              <b>Privacy.</b> The app sends your email nowhere. The only personal data we hold is the
              business contact and billing information you give us to deliver the key, invoices and
              support, held with the processors named in the app's privacy notes.
            </li>
            <li>
              <b>Warranty and liability.</b> We warrant that the app will do what its documentation
              says. If it doesn't and we can't fix it within 30 days of your report, you may end the
              license and we'll refund the unused part of the year. Beyond that, the app is provided
              as is. Neither of us is liable to the other for indirect, incidental or consequential
              damages, and our total liability is limited to what you paid us in the 12 months
              before the claim. Nothing here limits liability that can't be limited by law.
            </li>
            <li>
              <b>Ending the license.</b> You may stop using the app at any time; the refund policy
              says what's refundable. We may end the license if you break these terms and don't fix
              it within 30 days of notice. When it ends, remove the app.
            </li>
            <li>
              <b>Evaluation copies.</b> You may download and use Mailviewer for Mac without a license
              to evaluate it. An evaluation copy opens single messages and previews fully and shows
              the first 25 messages of a mailbox. It is provided as is, without warranty or support,
              and these terms otherwise apply to it.
            </li>
            <li>
              <b>The rest.</b> Michigan law governs, and courts in Kent County, Michigan have
              exclusive jurisdiction. These terms plus your order are the whole agreement for a
              license bought online. If we change these terms, the change applies at your next
              renewal, not during a paid year.
            </li>
          </ol>
        </div>

        <div className="prose-block" id="refunds">
          <h4>Refund policy</h4>
          <p>
            <b>Try before you buy.</b> The free web app on this site opens the same formats in your
            browser, and the Mac app runs as an evaluation copy without a key. Use them first; most
            questions about whether Mailviewer fits are answered there.
          </p>
          <p>
            <b>30 days, no questions.</b> If you buy a Team, Business or Site license online and it
            isn't right for you, email <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a> within 30
            days of purchase and we'll refund the full amount. We'll ask what didn't work, but you
            don't have to answer. For card purchases the refund is issued through Stripe, the
            merchant of record, and appears on the card you paid with.
          </p>
          <p>
            <b>After 30 days.</b> Licenses are for a year and aren't refunded for the unused part,
            with two exceptions: if the app doesn't do what its documentation says and we can't fix
            it within 30 days of your report, you can end the license and we'll refund the unused
            months; and if we discontinue Mailviewer for Mac during your year, we'll refund the
            unused months.
          </p>
          <p>
            <b>Renewals.</b> A renewal has its own 30-day window, counted from the renewal payment.
          </p>
          <p>
            <b>Extra seats.</b> Extra seats bought during the year follow the same rules, counted
            from their own purchase date.
          </p>
          <p>
            <b>Mac App Store purchases.</b> The Personal license is sold by Apple. Refunds for it go
            through Apple's refund process, not ours, and follow Apple's rules.
          </p>
          <p>
            <b>Site licenses under an agreement.</b> Where a site license is bought under a signed
            master software agreement, that agreement's refund terms apply instead.
          </p>
          <p>
            <b>How refunds are paid.</b> To the original payment method, within 10 business days of
            our confirmation. When a refund is paid, the license key stops being valid for updates
            and support, and you agree to remove the app.
          </p>
        </div>

        <div className="prose-block" id="web">
          <h4>The web app</h4>
          <p>
            The viewer on this site is free, with no account, no license and no fee. It is provided
            as is, without warranty: it reads your files on your own device and shows them to you,
            and if a file does not open, that is a bug to <a href="#/report">report</a>, not a claim
            against us. Its source is public under the MIT license, and you may run your own copy.
          </p>
        </div>

        <div className="prose-block" id="privacy">
          <h4>Privacy</h4>
          <p>
            What this site does and does not do with your mail is on the{" "}
            <a href="#/privacy">privacy page</a>, and you can{" "}
            <a href="#/verify">check it yourself</a>. The Mac app's privacy notes, including its
            update check and what we hold about you as a customer, are published with its downloads
            at{" "}
            <a href="https://updates.mailviewer.app/terms/#privacy" target="_blank" rel="noopener noreferrer">
              updates.mailviewer.app/terms
            </a>
            .
          </p>
        </div>
      </section>
      <Footer note="Questions about these terms: the contact page has the addresses." />
    </>
  );
}
