/**
 * dictate — minimal voice dictation for pi.
 *
 * Toggle dictation with alt+m (default; configurable via settings.json),
 * press it again to stop. Cancel with alt+n (also configurable) to discard
 * the in-flight transcript. Run /dictate-language <code> to switch the
 * transcription language for the session (default: en).
 *
 * Focus-aware: alt+m/alt+n are intercepted at the TUI input layer (before any
 * focused component), so dictation works inside ANY dialog — quiz popups,
 * ask_user_question, ctx.ui.editor()/input() — not just the main chat editor.
 *
 * Start rule: dictation only begins if some text-capable component is
 * focused; otherwise an ephemeral notification explains why nothing happened.
 * Opaque dialogs (quiz/ask selects) count as text-capable, but their internal
 * focus is invisible to us — Tab into the note/Other field first so the text
 * lands there.
 *
 * Stop rule: the delivery target is resolved fresh at stop time and the
 * transcript goes to whatever is focused THEN (editor-like components get a
 * direct setText append; opaque components get synthetic keystrokes). If
 * nothing text-capable is focused at stop, the transcript is copied to the
 * clipboard and a notification says so — a finished dictation is never lost.
 *
 * Requires:
 *   - sox installed (`brew install sox` — provides the `rec` command)
 *   - DEEPGRAM_API_KEY environment variable set
 *
 * Streaming model: audio is sent to Deepgram while you talk; the server
 * transcribes in real time and emits per-utterance "final" results. We
 * collect those finals and inject the concatenated text on stop. No
 * partials are shown in the editor (cosmetic-only), so quality is good
 * and the editor never shows revisable text.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, isKeyRelease, isKeyRepeat, type KeyId } from "@earendil-works/pi-tui";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Optional forensic logging: run pi with DICTATE_DEBUG=1 to append timestamped
// lifecycle events (listener hits, toggles, ws open/error/close with their
// generation) to /tmp/dictate-debug.log.
const DEBUG = !!process.env.DICTATE_DEBUG;
const dbg = (msg: string) => {
  if (!DEBUG) return;
  try {
    appendFileSync("/tmp/dictate-debug.log", `${new Date().toISOString()} ${msg}\n`);
  } catch {}
};

// Languages supported by nova-3, per Deepgram's models & languages overview:
// https://developers.deepgram.com/docs/models-languages-overview#nova-3
// Grouped as { language name → accepted codes }; the base code is first in
// each group.
const NOVA3_LANGUAGE_GROUPS: ReadonlyArray<{ name: string; codes: readonly string[] }> = [
  { name: "Multilingual (code-switching)", codes: ["multi"] },
  { name: "Afrikaans", codes: ["af", "af-ZA"] },
  { name: "Arabic", codes: ["ar", "ar-AE", "ar-SA", "ar-QA", "ar-KW", "ar-SY", "ar-LB", "ar-PS", "ar-JO", "ar-EG", "ar-SD", "ar-TD", "ar-MA", "ar-DZ", "ar-TN", "ar-IQ", "ar-IR"] },
  { name: "Armenian", codes: ["hy"] },
  { name: "Assamese", codes: ["as", "as-IN"] },
  { name: "Belarusian", codes: ["be"] },
  { name: "Bengali", codes: ["bn"] },
  { name: "Bosnian", codes: ["bs"] },
  { name: "Bulgarian", codes: ["bg"] },
  { name: "Catalan", codes: ["ca"] },
  { name: "Chinese (Cantonese, Traditional)", codes: ["zh-HK"] },
  { name: "Chinese (Mandarin, Simplified)", codes: ["zh", "zh-CN", "zh-Hans"] },
  { name: "Chinese (Mandarin, Traditional)", codes: ["zh-TW", "zh-Hant"] },
  { name: "Croatian", codes: ["hr"] },
  { name: "Czech", codes: ["cs", "cs-CZ"] },
  { name: "Danish", codes: ["da", "da-DK"] },
  { name: "Dutch", codes: ["nl"] },
  { name: "English", codes: ["en", "en-US", "en-AU", "en-GB", "en-IN", "en-NZ"] },
  { name: "Estonian", codes: ["et"] },
  { name: "Finnish", codes: ["fi"] },
  { name: "Flemish", codes: ["nl-BE"] },
  { name: "French", codes: ["fr", "fr-CA"] },
  { name: "Georgian", codes: ["ka", "ka-GE"] },
  { name: "German", codes: ["de"] },
  { name: "German (Switzerland)", codes: ["de-CH"] },
  { name: "Greek", codes: ["el"] },
  { name: "Gujarati", codes: ["gu", "gu-IN"] },
  { name: "Hebrew", codes: ["he"] },
  { name: "Hindi", codes: ["hi"] },
  { name: "Hungarian", codes: ["hu"] },
  { name: "Indonesian", codes: ["id"] },
  { name: "Italian", codes: ["it"] },
  { name: "Japanese", codes: ["ja"] },
  { name: "Kannada", codes: ["kn"] },
  { name: "Kazakh", codes: ["kk", "kk-KZ"] },
  { name: "Korean", codes: ["ko", "ko-KR"] },
  { name: "Latvian", codes: ["lv"] },
  { name: "Lithuanian", codes: ["lt"] },
  { name: "Macedonian", codes: ["mk"] },
  { name: "Malay", codes: ["ms"] },
  { name: "Marathi", codes: ["mr"] },
  { name: "Mongolian", codes: ["mn"] },
  { name: "Nepali", codes: ["ne"] },
  { name: "Norwegian", codes: ["no"] },
  { name: "Pashto", codes: ["ps", "ps-AF"] },
  { name: "Persian", codes: ["fa"] },
  { name: "Polish", codes: ["pl"] },
  { name: "Portuguese", codes: ["pt", "pt-BR", "pt-PT"] },
  { name: "Punjabi", codes: ["pa", "pa-IN"] },
  { name: "Romanian", codes: ["ro"] },
  { name: "Russian", codes: ["ru"] },
  { name: "Serbian", codes: ["sr"] },
  { name: "Slovak", codes: ["sk"] },
  { name: "Slovenian", codes: ["sl"] },
  { name: "Spanish", codes: ["es", "es-419"] },
  { name: "Swedish", codes: ["sv", "sv-SE"] },
  { name: "Tagalog", codes: ["tl"] },
  { name: "Tamil", codes: ["ta"] },
  { name: "Telugu", codes: ["te"] },
  { name: "Thai", codes: ["th", "th-TH"] },
  { name: "Turkish", codes: ["tr", "tr-TR"] },
  { name: "Ukrainian", codes: ["uk"] },
  { name: "Urdu", codes: ["ur"] },
  { name: "Vietnamese", codes: ["vi"] },
];

// Flattened { code, name } pairs used for lookup and autocomplete.
const NOVA3_LANGUAGES: ReadonlyArray<{ code: string; name: string }> = NOVA3_LANGUAGE_GROUPS.flatMap(
  ({ name, codes }) => codes.map((code) => ({ code, name })),
);
const LANG_BY_CODE = new Map(NOVA3_LANGUAGES.map(({ code, name }) => [code.toLowerCase(), name] as const));

const DEFAULT_LANGUAGE = "en";

// ── Settings (settings.json) ─────────────────────────────────────────────────
// Keybinds and the startup language are customizable from settings.json via a
// namespaced "dictate" object (the same pattern other pi extensions use, e.g.
// observational-memory). Project settings (.pi/settings.json) override global
// ones (~/.pi/agent/settings.json):
//
//   {
//     "dictate": {
//       "toggleKey": "alt+m",
//       "cancelKey": "alt+n",
//       "language": "en"
//     }
//   }
//
// Key strings are pi-tui key identifiers: modifiers (ctrl/shift/alt/super,
// any order, case-insensitive) joined with "+" before a base key — a letter,
// digit, symbol, or special name (escape, enter, tab, f1…f12, up/down/…).
// Unmodified printable keys are rejected (they would fire on every
// keystroke); bare special keys like "f6" are fine. Invalid values fall
// back to the defaults and a session-start notification explains what was
// ignored. /dictate-language overrides the startup language for the current
// session only.

interface DictateConfig {
  toggleKey: KeyId;
  cancelKey: KeyId;
  language: string;
}

const DEFAULT_CONFIG: DictateConfig = {
  toggleKey: "alt+m",
  cancelKey: "alt+n",
  language: DEFAULT_LANGUAGE,
};

const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const SPECIAL_KEYS = new Set([
  "escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear",
  "home", "end", "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
// Keys that are safe to bind WITHOUT modifiers: they never type text.
const SAFE_UNMODIFIED_KEYS = new Set([
  "escape", "esc", "delete", "insert", "home", "end", "pageup", "pagedown",
  "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);
// Printable symbol keys (pi-tui's SymbolKey set). Usable WITH modifiers —
// bare ones are rejected by the unmodified-key rule below.
const SYMBOL_KEYS = new Set("`-=[]\\;'\",./!@#$%^&*()_+|~{}:<>?".split(""));

/**
 * Validate a configured key string ("alt+m", "ctrl+shift+d", "f6", …) and
 * return its canonical KeyId, or null if invalid. Mirrors how pi-tui's own
 * matchesKey parses identifiers (lowercase, split on "+", order-free
 * modifiers), so anything accepted here matches input correctly.
 */
function parseConfiguredKey(raw: string): KeyId | null {
  const parts = raw
    .trim()
    .toLowerCase()
    .split("+")
    .map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !p)) return null;
  const key = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  const isBaseKey = /^[a-z0-9]$/.test(key) || SYMBOL_KEYS.has(key) || SPECIAL_KEYS.has(key);
  if (!isBaseKey) return null;
  if (mods.some((m) => !KEY_MODIFIERS.has(m))) return null;
  if (mods.length === 0 && !SAFE_UNMODIFIED_KEYS.has(key)) return null;
  const uniqMods = [...new Set(mods)];
  return (uniqMods.length > 0 ? `${uniqMods.join("+")}+${key}` : key) as KeyId;
}

/** Read the namespaced "dictate" object from a settings.json file, if present. */
function readDictateSettings(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown> | null;
    const nested = parsed?.["dictate"];
    return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : {};
  } catch {
    return {}; // malformed settings file — pi itself reports that; we just use defaults
  }
}

/** Validate one settings source's "dictate" object into config values + warnings. */
function normalizeDictateSettings(raw: Record<string, unknown>): { values: Partial<DictateConfig>; warnings: string[] } {
  const values: Partial<DictateConfig> = {};
  const warnings: string[] = [];

  for (const prop of ["toggleKey", "cancelKey"] as const) {
    const value = raw[prop];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      warnings.push(`dictate.${prop}: expected a string — using fallback`);
      continue;
    }
    const parsed = parseConfiguredKey(value);
    if (!parsed) {
      warnings.push(
        `dictate.${prop}: "${value}" is not a usable key id (e.g. "alt+m", "ctrl+shift+d", "f6"; plain printable keys are rejected)`,
      );
      continue;
    }
    values[prop] = parsed;
  }

  if (raw.language !== undefined) {
    if (typeof raw.language !== "string") {
      warnings.push(`dictate.language: expected a string — using fallback`);
    } else {
      const wanted = raw.language.trim().toLowerCase();
      const resolved = NOVA3_LANGUAGES.find(({ code }) => code.toLowerCase() === wanted);
      if (!resolved) {
        warnings.push(`dictate.language: "${raw.language}" is not a nova-3 language code`);
      } else {
        values.language = resolved.code;
      }
    }
  }

  return { values, warnings };
}

/** Load config: defaults ← global settings ← project settings (per key, so an
 *  invalid project value falls back to the global one, not the default). */
function loadConfig(cwd: string): { config: DictateConfig; warnings: string[] } {
  const global = normalizeDictateSettings(readDictateSettings(join(getAgentDir(), "settings.json")));
  const project = normalizeDictateSettings(readDictateSettings(join(cwd, ".pi", "settings.json")));
  return {
    config: { ...DEFAULT_CONFIG, ...global.values, ...project.values },
    warnings: [...global.warnings, ...project.warnings],
  };
}

// Deepgram streaming endpoint. Tuning notes:
//   model=nova-3        — flagship, sub-300ms latency, best accuracy
//   language=<code>     — only sent when not English (English is nova-3's default)
//   encoding=linear16   — raw 16-bit PCM (what sox/rec gives us with -e signed-integer -b 16)
//   sample_rate=16000   — 16kHz mono is the standard low-bandwidth STT format
//   interim_results=false — we only want finals, never partials
//   smart_format=true   — formats numbers, dates, currencies nicely
//   punctuate=true      — adds commas/periods/question marks
//   endpointing=300     — 300ms of silence ends an utterance (faster finals)
const deepgramUrl = (lang: string): string =>
  "wss://api.deepgram.com/v1/listen" +
  "?model=nova-3" +
  (lang !== DEFAULT_LANGUAGE ? `&language=${encodeURIComponent(lang)}` : "") +
  "&encoding=linear16" +
  "&sample_rate=16000" +
  "&channels=1" +
  "&interim_results=false" +
  "&smart_format=true" +
  "&punctuate=true" +
  "&endpointing=300";

type State = "idle" | "recording" | "stopping";

// ── Focus-aware delivery ──────────────────────────────────────────────────
// The TUI handle is captured once via a zero-height widget factory (the only
// extension-API surface that exposes it). With it we can:
//   1. Listen to ALL terminal input via tui.addInputListener — listeners run
//      before the focused component, so alt+m works even while a custom
//      dialog has stolen focus from the main editor (extension shortcuts are
//      otherwise only matched by the main editor component).
//   2. Inspect tui.focusedComponent to decide where the transcript goes.
// `focusedComponent` is declared private in the typings but is a plain
// runtime property — a benign peek, easily patched if pi internals change.
interface EditorLike {
  getText(): string;
  setText(text: string): void;
}
type Target =
  | { kind: "editor"; editor: EditorLike }
  | { kind: "typable"; component: { handleInput(data: string): void } };

const asEditorLike = (value: any): EditorLike | null =>
  value && typeof value.getText === "function" && typeof value.setText === "function" ? value : null;

// Same braille frames pi-tui's Loader uses.
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;

// Audio meter — a tiny rolling waveform rendered in the status row while recording.
// Tweakable knobs:
//   METER_CELLS       = how many bars wide
//   METER_TICK_MS     = how often bars shift left (smaller = snappier, more renders)
//   METER_FLOOR_DB    = level at which the bar is empty (more negative = more sensitive)
//   METER_CEILING_DB  = level at which the bar is full (less negative = needs louder to peg)
const METER_CELLS = 6;
const METER_TICK_MS = 60;
const PEAK_BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
// const PEAK_BLOCKS = ["⠀", "⣀", "⣄", "⣤", "⣦", "⣶", "⣷", "⣿"];
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;

/** Compute normalized RMS (0..1) over a buffer of signed 16-bit little-endian PCM samples. */
function rmsFromPcm16(buf: Buffer): number {
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount * 2; i += 2) {
    const s = buf.readInt16LE(i);
    sumSquares += s * s;
  }
  return Math.sqrt(sumSquares / sampleCount) / 32768;
}

/** Map a normalized RMS value to one of PEAK_BLOCKS by converting to dB and clamping into the visible range. */
function rmsToBlock(rms: number): string {
  if (rms <= 0) return PEAK_BLOCKS[0]!;
  const db = 20 * Math.log10(rms);
  const t = Math.max(0, Math.min(1, (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB)));
  const idx = Math.floor(t * (PEAK_BLOCKS.length - 1));
  return PEAK_BLOCKS[idx]!;
}

export default function (pi: ExtensionAPI) {
  // Keybinds + startup language from settings.json (see the Settings section
  // above). Read once at load — registerShortcut needs the keys immediately.
  const { config, warnings } = loadConfig(process.cwd());
  let warningsShown = false;

  let state: State = "idle";
  // Current transcription language (nova-3). Starts from the configured
  // default ("en" unless overridden in settings.json); switched at runtime
  // via /dictate-language. Read fresh at each startDictation, so a recording
  // in flight keeps the language it started with.
  let language = config.language;
  let rec: ChildProcessByStdio<null, Readable, Readable> | null = null;
  let ws: WebSocket | null = null;
  let finals: string[] = [];
  let activeCtx: ExtensionContext | null = null;
  let flushed = false;
  let cancelled = false;
  let stopTimeout: NodeJS.Timeout | null = null;
  let spinnerTimer: NodeJS.Timeout | null = null;
  let spinnerFrame = 0;
  // Session generation: incremented on every start and every cleanup. All
  // rec/ws event handlers capture the generation they belong to and no-op
  // when it's stale — otherwise a PREVIOUS session's socket erroring/closing
  // late (e.g. one we aborted mid-handshake) would run cleanup() and tear
  // down the CURRENT live session.
  let generation = 0;
  // Audio meter state. `meter` is a ring of recent RMS values, newest at
  // index METER_CELLS-1. `currentLevel` is the most recent RMS observed from
  // any audio chunk — the meter tick just samples it. Crucially we never reset
  // it: empty ticks re-render the last observed value, so the bars never drop
  // to silence just because no chunk happened to arrive in that 60ms window.
  let meterTimer: NodeJS.Timeout | null = null;
  let meter: number[] = new Array(METER_CELLS).fill(0);
  let currentLevel = 0;

  const setStatus = (msg: string | undefined) => {
    if (!activeCtx) return;
    activeCtx.ui.setStatus("dictate", msg);
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
  };

  const stopMeter = () => {
    if (meterTimer) {
      clearInterval(meterTimer);
      meterTimer = null;
    }
  };

  /** Start the meter ticking. Each tick shifts the ring and samples currentLevel. */
  const startMeter = () => {
    stopMeter();
    meter = new Array(METER_CELLS).fill(0);
    currentLevel = 0;
    // Recording dot: a text glyph colored via the theme, not an emoji — emoji
    // presentation renders double-width in its own baked-in color and visually
    // shouts in the footer. `●` is the same dot pi's own docs use for
    // indicators; theme "error" gives the red. (If you ever want strictly
    // ASCII, swap the glyph for "O".)
    const render = () => {
      const dot = activeCtx?.ui.theme.fg("error", "●") ?? "●";
      // Show the language code in the status row when it isn't the default,
      // so it's visible at a glance what is being transcribed.
      const langTag = language !== DEFAULT_LANGUAGE ? ` [${language}]` : "";
      setStatus(`${dot} ${meter.map(rmsToBlock).join("")} listening${langTag}…`);
    };
    render();
    meterTimer = setInterval(() => {
      meter.shift();
      meter.push(currentLevel);
      render();
    }, METER_TICK_MS);
  };

  /** Animate the dictate status row with a braille spinner + suffix message. */
  const startSpinner = (suffix: string) => {
    stopSpinner();
    spinnerFrame = 0;
    setStatus(`${SPINNER_FRAMES[0]} ${suffix}`);
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      setStatus(`${SPINNER_FRAMES[spinnerFrame]} ${suffix}`);
    }, SPINNER_INTERVAL_MS);
  };

  let tuiHandle: any = null;
  let removeInputListener: (() => void) | null = null;
  let lastCtx: ExtensionContext | null = null;

  /** Resolve where dictated text would go RIGHT NOW, based on keyboard focus. */
  const resolveTarget = (): Target | null => {
    const focused = tuiHandle?.focusedComponent;
    if (!focused) return null;
    // Editor-like focus: the main chat editor, custom editors, and the
    // ctx.ui.editor()/input() popups (their inner pi-tui Editor hangs off
    // `.editor`). These accept a guaranteed direct setText append.
    const editor = asEditorLike(focused) ?? asEditorLike(focused.editor);
    if (editor) return { kind: "editor", editor };
    // Opaque component with input handling (quiz/ask selects, selectors):
    // we can type into it, but whether the text lands depends on its
    // internal focus (e.g. the quiz note field must be Tab-focused).
    if (typeof focused.handleInput === "function") return { kind: "typable", component: focused };
    return null;
  };

  const flush = () => {
    if (flushed || !activeCtx) return;
    flushed = true;
    if (cancelled) return; // discard transcript on cancel
    const text = finals.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;

    // Legacy fallback: no TUI handle captured (non-TUI mode / older pi) —
    // append to the main chat editor exactly as before.
    if (!tuiHandle) {
      const current = activeCtx.ui.getEditorText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      activeCtx.ui.setEditorText(current + sep + text);
      return;
    }

    // Resolve the target NOW — focus may have changed while dictating.
    const target = resolveTarget();
    if (target?.kind === "editor") {
      const current = target.editor.getText() ?? "";
      const sep = current && !/\s$/.test(current) ? " " : "";
      target.editor.setText(current + sep + text);
      tuiHandle.requestRender?.();
      return;
    }
    if (target?.kind === "typable") {
      // Synthetic typing: the component routes the text wherever its
      // internal focus is. Text is plain printable words (whitespace
      // already normalized), so no keybindings/autocomplete can trigger.
      target.component.handleInput(text);
      tuiHandle.requestRender?.();
      return;
    }
    // Nothing to type into: don't throw the transcript away — stash it on
    // the clipboard and say so.
    try {
      const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.stdin.end(text);
    } catch {}
    activeCtx.ui.notify("Dictation finished but no input field is focused — transcript copied to clipboard", "warning");
  };

  const cleanup = () => {
    generation++; // invalidate the dying session's event handlers
    dbg(`cleanup → gen ${generation}`);
    flush();
    stopSpinner();
    stopMeter();
    if (stopTimeout) {
      clearTimeout(stopTimeout);
      stopTimeout = null;
    }
    if (rec) {
      try {
        rec.kill("SIGTERM");
      } catch {}
      rec = null;
    }
    if (ws) {
      try {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
      } catch {}
      ws = null;
    }
    finals = [];
    state = "idle";
    setStatus(undefined);
    activeCtx = null;
    flushed = false;
    cancelled = false;
  };

  const startDictation = (ctx: ExtensionContext) => {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      ctx.ui.notify("DEEPGRAM_API_KEY not set in environment", "error");
      return;
    }

    activeCtx = ctx;
    finals = [];
    flushed = false;
    cancelled = false;
    state = "recording";
    const myGeneration = ++generation;
    dbg(`start (gen ${myGeneration})`);
    startMeter();

    // Spawn sox `rec` to capture 16kHz / 16-bit / mono PCM to stdout.
    let proc: ChildProcessByStdio<null, Readable, Readable>;
    try {
      proc = spawn(
        "rec",
        [
          "-q", // quiet
          // Shrink sox's IO buffer so stdout flushes ~every 16ms instead of
          // the default ~256ms. 512 bytes = 256 samples = 16ms at 16kHz/16-bit
          // mono. This is the dominant source of meter latency.
          "--buffer", "512",
          "-r", "16000",
          "-c", "1",
          "-b", "16",
          "-e", "signed-integer",
          "-t", "raw",
          "-", // stdout
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (e: any) {
      ctx.ui.notify(`Failed to spawn 'rec'. Install sox: brew install sox`, "error");
      cleanup();
      return;
    }
    rec = proc;

    proc.on("error", (err) => {
      if (myGeneration !== generation) return;
      ctx.ui.notify(`rec error: ${err.message} (install sox: brew install sox)`, "error");
      cleanup();
    });

    proc.on("exit", (code) => {
      if (myGeneration !== generation) return; // stale recorder — a newer/ended session owns state
      // Natural exit on SIGTERM during stopDictation is fine. Anything else
      // mid-recording is a problem.
      if (state === "recording" && code !== null && code !== 0) {
        if (activeCtx) {
          activeCtx.ui.notify(`rec exited unexpectedly (code ${code})`, "warning");
        }
        cleanup();
      }
    });

    // Open Deepgram WebSocket. Auth via subprotocol (portable across Node native
    // WebSocket and browsers): `new WebSocket(url, ["token", API_KEY])`.
    try {
      ws = new WebSocket(deepgramUrl(language), ["token", apiKey]);
    } catch (e: any) {
      ctx.ui.notify(`Deepgram WS failed: ${e.message}`, "error");
      cleanup();
      return;
    }

    ws.addEventListener("open", () => {
      if (myGeneration !== generation) {
        dbg(`ws open (stale gen ${myGeneration}, current ${generation}) — ignored`);
        return;
      }
      dbg(`ws open (gen ${myGeneration})`);
      if (!rec || !ws) return;
      rec.stdout.on("data", (chunk: Buffer) => {
        // Track loudness for the meter (just the latest chunk's RMS — the meter
        // tick samples this), then forward to Deepgram.
        currentLevel = rmsFromPcm16(chunk);
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(chunk);
        }
      });
    });

    ws.addEventListener("message", (ev) => {
      if (myGeneration !== generation) return;
      try {
        const msg = JSON.parse(ev.data as string);
        if (msg.type === "Results" && msg.is_final) {
          const t = msg.channel?.alternatives?.[0]?.transcript;
          if (t) finals.push(t);
        }
        // We could also handle msg.type === "Metadata" (sent after CloseStream
        // finishes draining), but ws.close handles the same flush path.
      } catch {
        // ignore non-JSON frames
      }
    });

    ws.addEventListener("error", () => {
      if (myGeneration !== generation) {
        dbg(`ws error (stale gen ${myGeneration}, current ${generation}) — ignored`);
        return;
      }
      dbg(`ws error (gen ${myGeneration})`);
      if (activeCtx) activeCtx.ui.notify("Deepgram WebSocket error", "error");
      cleanup();
    });

    ws.addEventListener("close", (ev) => {
      if (myGeneration !== generation) {
        dbg(`ws close (stale gen ${myGeneration}, current ${generation}, code ${ev.code}) — ignored`);
        return;
      }
      dbg(`ws close (gen ${myGeneration}, code ${ev.code})`);
      // Server-initiated close (or our own close in cleanup): finalize.
      if (state === "recording" || state === "stopping") {
        cleanup();
      }
    });
  };

  /** Stop dictation, finalize transcript, append to editor. */
  const stopDictation = () => {
    if (state !== "recording") return;
    state = "stopping";
    stopMeter();
    startSpinner("finalizing…");

    // Stop the mic first so no more audio enqueues.
    if (rec) {
      try {
        rec.kill("SIGTERM");
      } catch {}
    }

    // Tell Deepgram we're done; it will flush remaining finals then close.
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "CloseStream" }));
      } catch {
        cleanup();
        return;
      }
      // Safety net: if Deepgram never closes the socket, force cleanup after 3s.
      stopTimeout = setTimeout(() => {
        if (state === "stopping") cleanup();
      }, 3000);
    } else {
      cleanup();
    }
  };

  /** Cancel dictation: discard any collected transcript and tear everything down immediately. */
  const cancelDictation = () => {
    if (state !== "recording" && state !== "stopping") return;
    cancelled = true;
    finals = [];
    // No need to wait for Deepgram to flush — we're throwing the result away.
    cleanup();
  };

  /** Toggle dictation, gated on there being somewhere for the text to go. */
  const toggleDictation = (ctx: ExtensionContext) => {
    lastCtx = ctx;
    if (state === "idle") {
      if (tuiHandle && !resolveTarget()) {
        ctx.ui.notify("No input field is focused — dictation not started", "warning");
        return;
      }
      startDictation(ctx);
    } else if (state === "recording") {
      stopDictation();
    }
    // Ignore presses during the "stopping" state — Deepgram is finalizing.
  };

  // Global input listener: catches alt+m/alt+n before ANY focused component,
  // which is what makes dictation work inside dialogs. Registered once the
  // TUI handle is captured (see session_start below).
  const onGlobalInput = (data: string) => {
    // Kitty flag-2 terminals send press + REPEAT + RELEASE events, and input
    // listeners run BEFORE the TUI's release filter (that filter only guards
    // dispatch to the focused component). matchesKey also ignores the Kitty
    // event type. Without this guard a single physical alt+m press toggles
    // TWICE: press starts dictation, release instantly stops it and closes
    // the WebSocket mid-handshake — which then surfaces as
    // "Deepgram WebSocket error" (and its stale error event can kill the NEXT
    // session). Filter to press events only.
    if (isKeyRelease(data) || isKeyRepeat(data)) return undefined;
    if (matchesKey(data, config.toggleKey)) {
      dbg(`toggle key (data=${JSON.stringify(data)}) state=${state}`);
      if (lastCtx) toggleDictation(lastCtx);
      return { consume: true };
    }
    if (matchesKey(data, config.cancelKey)) {
      dbg(`cancel key (data=${JSON.stringify(data)}) state=${state}`);
      cancelDictation();
      return { consume: true };
    }
    return undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    // Surface ignored settings values once per load (not per session).
    if (warnings.length > 0 && !warningsShown) {
      warningsShown = true;
      ctx.ui.notify(`dictate: ${warnings.join("; ")}`, "warning");
    }
    if (ctx.mode !== "tui" || tuiHandle) return;
    // Capture the TUI handle via an invisible zero-height widget. The
    // listener function reference is stable, so even if the factory re-runs
    // the TUI's listener Set de-dupes it.
    ctx.ui.setWidget("dictate-tui-handle", (tui: any) => {
      tuiHandle = tui;
      removeInputListener = tui.addInputListener(onGlobalInput);
      return { render: () => [], invalidate: () => {} };
    });
  });

  // Shortcut registrations kept as a fallback for contexts where the TUI
  // handle was never captured (non-TUI modes, older pi): they only fire when
  // the main editor is focused, but that's precisely the legacy path. When
  // the listener IS installed it consumes the key first, so no double-fire.
  pi.registerShortcut(config.toggleKey, {
    description: "Toggle voice dictation (Deepgram)",
    handler: async (ctx) => {
      toggleDictation(ctx);
    },
  });

  // Dedicated cancel binding. Dictation-only — a no-op when no dictation is
  // in flight, so it's safe to hammer without affecting anything else.
  pi.registerShortcut(config.cancelKey, {
    description: "Cancel voice dictation (discard transcript)",
    handler: async () => {
      cancelDictation();
    },
  });

  // /dictate-language — pick the transcription language for nova-3.
  // Accepts a language code (en, sv, pt-BR, multi) or a language name
  // ("Japanese"). Argument completion matches on both, so typing "ja" or
  // "jap…" both suggest Japanese. No args shows the current language.
  pi.registerCommand("dictate-language", {
    description: "Set dictation language for nova-3 (e.g. ja, sv, pt-BR, multi)",
    getArgumentCompletions: (prefix: string) => {
      const p = prefix.trim().toLowerCase();
      const matches = NOVA3_LANGUAGES.filter(
        ({ code, name }) => code.toLowerCase().startsWith(p) || name.toLowerCase().startsWith(p),
      );
      if (matches.length === 0) return null;
      return matches.map(({ code, name }) => ({ value: code, label: code, description: name }));
    },
    handler: async (args: string, ctx) => {
      const arg = args.trim();
      if (!arg) {
        const name = LANG_BY_CODE.get(language.toLowerCase());
        ctx.ui.notify(
          `Dictation language: ${language}${name ? ` (${name})` : ""}. Usage: /dictate-language <code|name>` +
            ` — set "dictate.language" in settings.json to change the startup default`,
          "info",
        );
        return;
      }
      const key = arg.toLowerCase();
      const resolved =
        NOVA3_LANGUAGES.find(({ code }) => code.toLowerCase() === key) ??
        NOVA3_LANGUAGES.find(({ name }) => name.toLowerCase() === key);
      if (!resolved) {
        ctx.ui.notify(
          `Unknown language "${arg}" — tab-complete /dictate-language for supported nova-3 codes`,
          "error",
        );
        return;
      }
      language = resolved.code;
      ctx.ui.notify(
        `Dictation language: ${resolved.code} (${resolved.name})` +
          (state !== "idle" ? " — takes effect on next dictation" : ""),
        "info",
      );
    },
  });

  pi.on("session_shutdown", () => {
    if (state !== "idle") cleanup();
    removeInputListener?.();
    removeInputListener = null;
  });
}
