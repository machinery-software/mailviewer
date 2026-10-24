import { ISSUES_URL } from "../config";
import { Footer } from "./Footer";

/**
 * #/help: how to use the viewer, for someone who was handed an email file.
 * Trimmed to what the browser version does; the Mac app's guide is at
 * updates.mailviewer.app/help/ and has the parts that need a Mac (Quick
 * Look, the Help menu, the inspector).
 */
export const MAC_HELP_URL = "https://updates.mailviewer.app/help/";

export default function Help() {
  return (
    <>
      <section className="section section-narrow">
        <h2>Help</h2>
        <h3>Opening and reading an email file in your browser</h3>
        <p>
          mailviewer opens email files: a message someone saved (an Outlook .msg, an .eml), a
          mailbox exported from Mail or Gmail, an old Outlook .pst. It runs in this browser tab
          and nothing you open leaves your computer: there is no upload, no account and no
          cookie. <a href="#/privacy">How that is enforced →</a>
        </p>

        <div className="prose-block">
          <h4>Open a file</h4>
          <p>
            Drag the file onto this page, or go to <a href="#/open">Open a file</a> and choose
            it. Several at once are fine, and a mailbox lists every message it holds. Files
            are recognised by what is in them, not by their name, so a .msg that was renamed
            still opens. Formats: .eml, .emlx, .msg, .oft, .mbox, .pst, .ost, .olm and .mht.
          </p>

          <h4>Read a message</h4>
          <p>
            The <b>Message</b> tab shows the text as the sender formatted it. Pictures that
            live on a server are never fetched; a line above the message says how many were
            blocked, so opening a message here tells nobody you read it. <b>Headers</b> shows
            the internet headers exactly as the file records them, and <b>Source</b> the file
            itself. A link opens in a new tab only when you click it.
          </p>

          <h4>Search</h4>
          <p>
            With a mailbox open, type in <i>Search these messages…</i> above the list. The list
            narrows as you type and the words are highlighted in the message you are reading.
          </p>

          <h4>Attachments</h4>
          <p>
            Each attachment is listed under the message with its size. Clicking one saves it
            to your downloads folder, straight from the file you opened; nothing is fetched.
          </p>

          <h4>Print, or save as PDF</h4>
          <p>
            The <b>Print</b> menu above a message prints that message, or the whole list of
            the messages shown. Your browser's own print command (⌘P on a Mac, Ctrl+P on
            Windows) prints the message too, and every browser's print dialog can save a PDF
            instead.
          </p>

          <h4>Keyboard shortcuts</h4>
          <p>
            The browser's: ⌘P / Ctrl+P prints the open message, ⌘F / Ctrl+F finds words on the
            page, and Esc closes a menu. There is nothing else to learn.
          </p>
        </div>

        <div className="callout">
          <strong>On a Mac?</strong> The Mac app previews a message when you press Space in
          Finder, opens whole folders, and has a message inspector that shows what each file
          records about where it came from.{" "}
          <a href={MAC_HELP_URL} target="_blank" rel="noopener noreferrer">
            The Mac app's guide →
          </a>
        </div>

        <div className="prose-block">
          <h4>Something did not open</h4>
          <p>
            A file that refuses to open is a bug worth telling us about:{" "}
            <a href="#/report">report a problem</a> from inside the viewer, or open an issue on{" "}
            <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
              GitHub
            </a>
            . Never attach the message itself unless you are sure it holds nothing private.
          </p>
        </div>
      </section>

      <Footer
        note={
          <>
            Looking for how to deploy the Mac app?{" "}
            <a href="https://updates.mailviewer.app/admin/" target="_blank" rel="noopener noreferrer">
              The admin guide
            </a>
            .
          </>
        }
      />
    </>
  );
}
