// "Set up a local model": a step-by-step guide to installing Ollama and getting a model, with a suggestion that fits
// the graphics card. The planner itself starts an installed Ollama; installing and downloading stay with the user.
import type { GpuInfo, ModelsResponse } from "../../../shared/types";
import { $, api, esc } from "../core/dom";
import { ext, icon } from "../core/icons";

/** Models checked to exist in Ollama's library, all with tool use and thinking. need: GPU memory (GB) to run well,
 *  leaving room for the planner's long prompts. */
const MODELS = [
  { tag: "qwen3.8:27b", size: 17.7, need: 22, note: "Best results. For 24 GB cards and Macs with 32 GB or more." },
  { tag: "gemma4:12b", size: 8.0, need: 12, note: "Good balance. For 12-16 GB cards." },
  { tag: "qwen3.5:9b", size: 6.6, need: 8, note: "For 8-12 GB cards." },
  { tag: "qwen3.5:4b", size: 3.3, need: 5, note: "For 6-8 GB cards, or no graphics card (slow)." },
];

/** The biggest model that fits (Macs share memory with everything else, so leave them more room). */
function suggestion(gpu: GpuInfo | null) {
  if (!gpu) return null;
  const usable = gpu.unified ? gpu.memGb * 0.65 : gpu.memGb;
  return MODELS.find((m) => m.need <= usable) || MODELS.at(-1)!;
}

const DOWNLOAD = "https://ollama.com/download";

function stepsHtml(models: ModelsResponse | null, gpu: GpuInfo | null) {
  const o = models?.ollama, localCount = models?.local.length || 0;
  const pick = suggestion(gpu);
  const status = o?.running ? `<span class="ok-text">${icon("check")} Ollama is running${localCount ? ` with ${localCount} model${localCount > 1 ? "s" : ""}` : ""}.</span>`
    : o?.installed ? "Ollama is installed but didn't start. Open it from the Start menu (Windows) or Applications (Mac)."
    : "Ollama isn't installed yet.";
  const rows = MODELS.map((m) => `
    <tr class="${pick?.tag === m.tag ? "pick" : ""}">
      <td><code>${m.tag}</code>${pick?.tag === m.tag ? ` <span class="pick-badge">suggested</span>` : ""}<div class="hint">${esc(m.note)}</div></td>
      <td class="num">${m.size.toFixed(1)} GB</td>
      <td><button class="btn copy" data-copy="ollama pull ${m.tag}" title="Copy the command">${icon("copy")} Copy</button></td>
    </tr>`).join("");
  return `
    <ol class="guide-steps">
      <li><b>Install Ollama.</b> It's free and runs AI models on your own computer (Windows, macOS and Linux).
        <div class="guide-actions"><a class="btn solid" href="${DOWNLOAD}" target="_blank" rel="noopener">Download Ollama${ext()}</a></div></li>
      <li><b>Let it run.</b> Ollama normally starts with your computer. If it's installed but not running, the planner starts it for you.
        <div class="hint guide-status">${status}</div></li>
      <li><b>Download a model.</b> ${gpu ? `Your graphics: <b>${esc(gpu.name)}</b> with ${gpu.memGb} GB${gpu.unified ? " shared memory" : ""}.` : "Pick by your graphics card's memory (VRAM)."}
        Open a terminal (Windows: Start, type <i>Terminal</i>; Mac: <i>Terminal</i> app), paste the copied command (<code>ollama pull</code> and the model name) and press Enter.
        <table class="guide-models"><tbody>${rows}</tbody></table>
        <div class="hint">Bigger models plan better but need more memory. If a model doesn't fit, it spills into normal RAM and gets very slow, so leave a few GB free and close games or video apps while planning. More models: <a href="https://ollama.com/search" target="_blank" rel="noopener">ollama.com/search${ext()}</a></div></li>
      <li><b>Pick it in the planner.</b> Click Detect, then choose the model under "Local · Ollama".
        <div class="guide-actions"><button class="btn" data-detect>${icon("refresh")} Detect</button> <span class="hint" data-detect-result></span></div></li>
    </ol>
    <p class="hint">Local models are free and private, but slower and less thorough than Claude on long trips. The planner gives them extra help (real places, opening hours, checks afterwards).</p>`;
}

export async function openLocalGuide(refresh: () => Promise<ModelsResponse | null>) {
  const dialog = $<HTMLDialogElement>("#guideDialog");
  const body = $("#guideBody");
  body.innerHTML = `<p class="hint">Checking this computer…</p>`;
  dialog.showModal();
  const [models, gpu] = await Promise.all([refresh(), api<GpuInfo | null>("/api/gpu").catch(() => null)]);
  const render = (m: ModelsResponse | null) => {
    body.innerHTML = stepsHtml(m, gpu);
    for (const b of body.querySelectorAll<HTMLButtonElement>("[data-copy]")) b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy!); b.innerHTML = `${icon("check")} Copied`; }
      catch { prompt("Copy this command:", b.dataset.copy!); }
    };
    const detect = body.querySelector<HTMLButtonElement>("[data-detect]")!;
    detect.onclick = async () => {
      detect.disabled = true;
      const fresh = await refresh();
      render(fresh);
      const n = fresh?.local.length || 0;
      body.querySelector("[data-detect-result]")!.textContent = n ? `Found ${n} local model${n > 1 ? "s" : ""}. Pick one in the Model menu.` : "No models found yet.";
    };
  };
  render(models);
}
