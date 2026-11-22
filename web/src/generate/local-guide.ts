// The built-in model suggestions, by graphics memory: used by Settings → Local models when ollama.com can't be read
// (it normally lists current models from the Ollama library instead).
import type { GpuInfo } from "../../../shared/types";

/** Models checked to exist in Ollama's library, all with tool use and thinking. need: GPU memory (GB) to run well,
 *  leaving room for the planner's long prompts. */
export const MODELS = [
  { tag: "qwen3.8:27b", size: 17.7, need: 22, note: "Best results. For 24 GB cards and Macs with 32 GB or more." },
  { tag: "gemma4:12b", size: 8.0, need: 12, note: "Good balance. For 12-16 GB cards." },
  { tag: "qwen3.5:9b", size: 6.6, need: 8, note: "For 8-12 GB cards." },
  { tag: "qwen3.5:4b", size: 3.3, need: 5, note: "For 6-8 GB cards, or no graphics card (slow)." },
];

/** The biggest model that fits (Macs share memory with everything else, so leave them more room). */
export function suggestion(gpu: GpuInfo | null) {
  if (!gpu) return null;
  const usable = gpu.unified ? gpu.memGb * 0.65 : gpu.memGb;
  return MODELS.find((m) => m.need <= usable) || MODELS.at(-1)!;
}
