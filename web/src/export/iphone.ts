// Export → For iPhone. An iPhone only previews a downloaded HTML file (no scripts: no Today, Expenses or Journal), and
// nothing on it can open such a file in a browser. So the phone file goes into a small viewer page instead (site/phone/,
// published with the project): opened once from the QR code and added to the Home Screen, it keeps the trip file on the
// phone and works offline. The viewer has no trip in it; the file never leaves the phone.
import qrcode from "qrcode-generator";
import { closeOnBackdrop, esc } from "../core/dom";
import { icon } from "../core/icons";
import { downloadForPhone } from "./offline";

/** Where the viewer is published (GitHub Pages of the project: .github/workflows/pages.yml). */
export const PHONE_VIEWER_URL = "https://notetuwu.github.io/trip-planner/phone/";

export function openIphoneGuide() {
  const d = document.createElement("dialog");
  d.className = "keys-dialog iphone-dialog";
  const q = qrcode(0, "M"); q.addData(PHONE_VIEWER_URL); q.make();
  d.innerHTML = `<form method="dialog" class="ask-form">
      <h3>${icon("phone")} The trip on an iPhone</h3>
      <p class="ask-text">An iPhone only previews a downloaded file: Today, Expenses and the Journal don't work in that preview. This small viewer page runs it properly, keeps it on the phone and works offline. Your trip isn't uploaded: the page only opens the file on the phone.</p>
      <div class="ip-steps">
        <div class="qr" aria-label="QR code for the viewer page">${q.createSvgTag({ cellSize: 4, margin: 2, scalable: true })}</div>
        <ol>
          <li><b>Scan this</b> with the iPhone's camera and open the page.<br><a href="${esc(PHONE_VIEWER_URL)}" target="_blank" rel="noopener">${esc(PHONE_VIEWER_URL.replace(/^https:\/\//, ""))}</a></li>
          <li>Tap Share, then <b>Add to Home Screen</b>. Open <b>Trips</b> from there.</li>
          <li><b>Get the trip file onto the phone</b> (AirDrop, iCloud Drive, a message to yourself) and pick it in Trips with “Open a trip file”.</li>
        </ol>
      </div>
      <p class="hint">Steps 1 and 2 are needed once per phone. For a changed plan, send the new file and open it in Trips: what was ticked, paid and written on the phone stays. Other phones can open the downloaded file directly, or use the same page.</p>
      <p class="hint">Rather not use the page? Download the trip file and open it in an HTML viewer app on the iPhone (one that runs the page's scripts). Whether what you enter is still there the next time depends on the app, so try it before the trip: write a journal line, close the app completely, and open the file again.</p>
      <div class="ask-acts"><button type="button" class="btn" data-ip-file>${icon("download")} Download the trip file</button><button type="submit" class="btn solid">Done</button></div>
    </form>`;
  document.body.append(d);
  closeOnBackdrop(d);
  d.addEventListener("close", () => d.remove());
  d.querySelector<HTMLButtonElement>("[data-ip-file]")!.onclick = () => downloadForPhone();
  d.showModal();
}
