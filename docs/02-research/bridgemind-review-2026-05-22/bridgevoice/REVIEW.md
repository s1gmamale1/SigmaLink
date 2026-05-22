# BridgeVoice Launch Video — Full Review

> Video: "Stop Typing. Start Shipping." — BridgeMind launch of BridgeVoice  
> Runtime: ~4m 17s | Frames analyzed: 32 (uni_001–uni_032) + scene_001 | Transcript: fully read  
> Reviewer: SigmaLink Research Agent | Date: 2026-05-22

---

## Product Summary

BridgeVoice is a standalone desktop voice-to-text application (Windows / macOS / Linux) distributed as part of the BridgeMind Pro subscription ($40/mo annual, 3-day free trial). Its declared purpose is "vibe coding" — capturing long-form spoken prompts and injecting them as text into agentic coding tools such as Claude Code. The presenter claims 63,000+ words transcribed personally using the tool over several months and 181 wpm average speaking rate tracked. Core differentiators claimed: local/cloud transcription toggle, a vocabulary dictionary with find-and-replace shortcuts, and an AI-enhanced custom instructions layer that reformats raw speech into structured coding prompts.

The product runs as a persistent floating widget ("pill") visible across applications, activated by a configurable push-to-talk hotkey.

---

## Feature Breakdown

---

### 1. Splash Screen / Onboarding

**Screenshot:** `01_splash-landing_t0s.jpg` | t≈0s  
Dark Electron window. Tagline "Stop Typing. Start Shipping." Blue "Start Building" CTA button center. Branding: BridgeVoice logo with BridgeMind attribution. Standard first-run landing.

**INTEGRATION NOTE:** SigmaLink already has an Electron shell. The splash pattern is not something to adopt — SigmaLink's pane-based UI is more advanced. No action needed. Effort: N/A.

---

### 2. Overview Dashboard — Usage Statistics

**Screenshot:** `02_overview-dashboard-stats_t8s.jpg` | t≈8s  
**Screenshot:** `13_overview-live-word-count-update_t40s.jpg` | t≈40s

Shows an "Overview" page in the app's left-nav sidebar. Four headline metrics:
- **Total Words** spoken (63,640 → 63,651 live update during demo)
- **Transcription Time** (5h 52m)
- **Recordings** count (2,273)
- **Avg WPM** (181 wpm)

Below: a **Recent Activity** feed listing the last ~5 spoken prompts, each with timestamp, word count, and transcription mode label ("Claude", "Ruflo" etc.). A "View Full History" link implies a paginated session history view.

**INTEGRATION NOTE (SigmaVoice / SigmaLink):** SigmaVoice (sigmavoice-v0.2.0) already does ms-timestamped segment output, but has no usage dashboard. Adding a word-count accumulator and WPM tracker to SigmaVoice's main window would meaningfully differentiate it for power users who want to track their dictation habits. The recent-activity feed maps naturally onto SigmaLink's existing session history concept (each pane already tracks its interaction log). Target module: **SigmaVoice settings/stats pane**. Effort: **S** (accumulate counters from existing segment metadata, render in a new tab).

---

### 3. BridgeSpace Multi-Pane IDE Context (Product Ecosystem)

**Screenshot:** `03_bridgespace-multi-pane-ide_t24s.jpg` | t≈24s  
**Screenshot:** `09_voice-injected-claude-code-prompt_t128s.jpg` | t≈128s

BridgeVoice is shown running *alongside* BridgeSpace — BridgeMind's own multi-pane Claude Code orchestrator. Frame uni_004 shows a 3×2 grid of Claude Code panes with workspace tabs (Workspace 1, 2, 3) — functionally identical in concept to SigmaLink's Command Room. Each pane shows Claude Code v2.1.77 / Opus 4.6 1M context / Claude Max headers. The voice widget (top-right "BridgeVoice" pill) is visible as a persistent overlay.

Frame uni_016 shows voice text successfully injected into a single zoomed Claude Code pane prompt box, confirming the push-to-talk-to-clipboard workflow.

**INTEGRATION NOTE:** This is the primary competitive signal. BridgeMind has shipped the exact same multi-pane-orchestrator concept that SigmaLink already has (Command Room). SigmaLink is not behind — it is at feature parity or ahead (per-pane worktrees, Ruflo MCP, skills tab are not visible in BridgeSpace). The key gap: BridgeMind bundles a standalone voice widget; SigmaLink has SigmaVoice as a separate app. **Tight integration of SigmaVoice into the SigmaLink pane prompt bar** (inline record button + auto-inject) would close the UX gap. Target module: **pane prompt input bar**. Effort: **M** (IPC between SigmaVoice process and SigmaLink renderer; or inline Whisper.cpp invocation directly in SigmaLink pane).

---

### 4. Transcription Mode — Local vs Cloud Toggle

**Screenshot:** `04_settings-local-cloud-toggle_t64s.jpg` | t≈64s  
**Screenshot:** `05_settings-local-mode-selected_t80s.jpg` | t≈80s  
**Screenshot:** `06_settings-full-local-model-list_t56s.jpg` | t≈56s

Settings page "Transcription Mode" section shows two cards:
- **Local** — "On-device transcription — fully private, no internet needed." Tags: Private, Offline, English.
- **Cloud** — "More accurate, faster, and supports 100+ languages." Tags: 100+ Languages, Fast, Accurate.

Currently selected model (local): **Base (English) 142 MB** (highlighted in blue). Other model rows visible: Tiny (English) 75 MB, Small (English) 466 MB, Medium (English) 1500 MB, Large v2, Small Large v4. Each shows a "Download required" badge or is already downloaded.

This is backed by Whisper.cpp model variants — identical to what SigmaVoice already ships.

**INTEGRATION NOTE:** SigmaVoice already uses bundled Whisper.cpp and already supports model selection. The UX gap is the explicit **Local vs Cloud card toggle** and the associated cloud backend. SigmaVoice has no cloud path today. Adding an optional cloud path (e.g., OpenAI Whisper API or a SigmaLink cloud endpoint) with a visible toggle in SigmaVoice settings would directly match this feature and extend to non-English speakers. Target module: **SigmaVoice settings**. Effort: **M** (add cloud transcription path behind a settings toggle; local path already exists).

---

### 5. Input Device Selection

**Screenshot:** `06_settings-full-local-model-list_t56s.jpg` | t≈56s

Within Settings, an "Input Device" section shows two microphone inputs:
- HyperX QuadCast 2 S (Default) — microphone input
- HyperX QuadCast 2 S — second listing (audio input)
- HyperX QuadCast 2 S (Default) — output

Standard audio device picker. No advanced features visible (no VAD threshold, noise gate, etc.).

**INTEGRATION NOTE:** SigmaVoice should already handle device selection via the system audio API. If not exposed in settings, add a device dropdown to SigmaVoice settings. Low-value unless users have multiple mics. Target module: **SigmaVoice settings**. Effort: **S**.

---

### 6. Dictionary — Find-and-Replace Vocabulary Shortcuts

**Screenshot:** `07_dictionary-saved-terms_t88s.jpg` | t≈88s  
**Screenshot:** `08_dictionary-replacement-mapping_t96s.jpg` | t≈96s

Dedicated "Dictionary" page (left-nav). Two-field form: **Original Term** → **Replacement**, plus optional **Category** tag. Saved Terms list (4 entries visible):
- `bridgemind api` → `@bridgemind-api` (Uncategorized)
- `bridgemind ui` → `@bridgemind-ui`
- `bridge mind` → `BridgeMind`
- `Nbm run build` → `npm run build`

The presenter's use-case: speaking natural language that gets substituted into `@repo-name` Claude Code file references, CLI command corrections, and proper-noun casing fixes.

Frame uni_017 (`10_at-mention-autocomplete-claude-code_t136s.jpg`) confirms the output: after voice injection, typing `@bridgemind-api` in Claude Code's input box triggers the standard `@`-mention file/resource autocomplete dropdown, listing `bridgemind:project://...` MCP resources.

**INTEGRATION NOTE:** This is a high-value feature absent from SigmaVoice. A dictionary layer sits post-transcription (raw whisper output → substitution rules → final text). Implementation is straightforward: a JSON ruleset stored in SigmaVoice config, applied via string replace after each segment. The `@mention` use-case is especially relevant to SigmaLink since each pane agent can be addressed by name — a spoken "sigma pane two" could substitute to `@pane-2`. Target module: **SigmaVoice post-processing pipeline**. Effort: **S** (the substitution logic is trivial; UI to manage the list is another S).

---

### 7. Custom Instructions — AI Prompt Reformatting

**Screenshot:** `11_custom-instructions-page_t144s.jpg` | t≈144s

A "Custom Instructions" page under left-nav "Instructions" tab. Large textarea (~200 lines capacity) pre-filled with an instruction set. From the transcript, the content tells BridgeVoice how to format transcriptions:
- "Use all lowercase in Slack" / "Please break text into paragraphs"
- Format camelCase and function names in camelCase
- Format file paths and shell commands exactly as spoken
- When "new line" / "open bracket" / "close bracket" is said, output the corresponding literal
- Technical terms/filenames unless they are acronyms (e.g., API, SDK, UI) — do not add filler words
- Output clean, terse, ready-to-paste code or docs

A character counter ("594 / 1,225 characters") and "Save Instructions" button are visible. This is not just a phonetic dictionary — it is an LLM prompt that is passed as context to the cloud transcription backend to shape output format.

**INTEGRATION NOTE:** This is the most sophisticated feature in the video. Two sub-components:
1. **Verbal command macros** (say "new line" → insert `\n`) — implementable in SigmaVoice locally without cloud, as a post-processing regex/replace step on top of the dictionary layer.
2. **LLM-guided reformatting** — the cloud transcription API accepts a system prompt that reframes raw speech into clean code-ready text. This requires a cloud backend; it cannot run locally with Whisper alone.

For SigmaLink's immediate roadmap: implement the verbal-command-macro half (local, no cloud dependency) as part of the dictionary feature. The LLM reformatting half is a future SigmaVoice Cloud feature. Target module: **SigmaVoice post-processing pipeline** (macros); **SigmaVoice Cloud settings** (LLM reformatting). Effort: **S** for macros, **L** for full LLM reformatting.

---

### 8. Floating Widget Pill / Push-to-Talk HUD

Visual evidence across multiple frames: a persistent **"BridgeVoice"** pill/badge floats in the top-right corner of the screen while other applications are in focus (visible in uni_009, uni_017, etc.). The presenter describes configuring a push-to-talk key for near-immediate transcription. No recording waveform or visual feedback of recording state is visible in the frames captured; this may occur during active dictation frames that weren't captured as stills.

**INTEGRATION NOTE:** SigmaVoice v0.2.0 is already a standalone app. Whether it has a comparable floating overlay is not documented in this review's scope. If SigmaVoice currently requires window focus to initiate recording, adding a system-level always-on-top push-to-talk widget would match this UX. Target module: **SigmaVoice main window / tray**. Effort: **M** (Electron BrowserWindow with `alwaysOnTop` and global keyboard shortcut registration).

---

### 9. Pricing / Subscription Model

**Screenshot:** `12_pricing-plans_t184s.jpg` | t≈184s

BridgeMind.ai pricing page shows three tiers (annual billing):
- **Free** — $0, BridgeSpace (AI/O), multi-agent sessions
- **Basic** — $16/mo (billed annually), adds email support
- **Pro** — $40/mo (billed annually), adds BridgeMCP, BridgeVoice, BridgeCode (coming soon), Premium SKUs, Prompt Library, Priority support, Early Access

BridgeVoice is **Pro-only**. 3-day free trial. 50% discount for first 3 months advertised in video description.

**INTEGRATION NOTE:** Competitive context — BridgeMind gates voice at $40/mo. SigmaLink/SigmaVoice bundles Whisper.cpp free (local). This is a significant positioning advantage for SigmaLink: emphasize "free, local, private voice" vs BridgeMind's paid cloud voice. No code action needed; marketing/positioning note. Effort: N/A.

---

## Edges Table — What SigmaLink Already Has That BridgeVoice Lacks

| Area | SigmaLink Edge | BridgeVoice Status |
|---|---|---|
| Multi-pane orchestration | Command Room with 6-pane PTY grid, per-pane git worktrees, workspace tabs | BridgeSpace has similar grid but no per-pane worktree browsing visible |
| MCP integration | Ruflo MCP shared memory, hooks, semantic routing across all panes | "BridgeMCP" listed as Pro feature, not demoed in this video |
| Skills tab | In-app skills marketplace with slash-command injection (W-5) | Not visible; BridgeVoice is a standalone tool, no in-app skill runtime shown |
| Local voice — bundled | SigmaVoice bundles Whisper.cpp, free, fully offline | BridgeVoice also has local Whisper; parity here |
| Subscription cost for voice | Free (bundled) | $40/mo Pro required |
| PTY shell-first architecture | Full PTY with grace window, shell-first pivot (W-4) | BridgeSpace shows Claude Code panes; architecture unknown |
| Agent coordination | Ruflo DAA, hive-mind, hierarchical mesh topology | BridgeMind coordination not shown in this video |
| Timestamp-segmented output | SigmaVoice ms-level segment timestamps | Not shown; unclear if BridgeVoice exposes segment metadata |

---

## Top 5 Integration Recommendations (Ranked by Value / Effort)

### 1. Dictionary (find-and-replace substitutions) in SigmaVoice
- **Value:** High — directly resolves the most common voice-to-code friction: proper nouns, CLI commands, @-mentions, casing.
- **Effort:** S
- **Target:** SigmaVoice post-processing pipeline + settings UI
- **Notes:** JSON ruleset, applied after each Whisper segment. Ship a starter set: "new line" → `\n`, "at pane one" → `@pane-1`, etc.

### 2. Verbal command macros (subset of Custom Instructions)
- **Value:** High — verbal punctuation and structural commands are immediately useful for code dictation.
- **Effort:** S (regex/replace layer on top of dictionary)
- **Target:** SigmaVoice post-processing pipeline
- **Notes:** Implement a reserved-word list ("new line", "open bracket", "close bracket", "tab", "semicolon") that maps to literal output characters. No LLM dependency.

### 3. Usage statistics dashboard in SigmaVoice
- **Value:** Medium — word count, WPM, session history give users a feedback loop and a reason to stay engaged with the tool.
- **Effort:** S
- **Target:** SigmaVoice stats pane (new tab or sidebar section)
- **Notes:** All data already exists in segment metadata. Accumulate per-session and persist in a local SQLite or JSON store.

### 4. Inline push-to-talk integration in SigmaLink pane prompt bar
- **Value:** High — eliminates the context switch of alt-tabbing to SigmaVoice; voice directly targets the focused pane's input.
- **Effort:** M
- **Target:** SigmaLink Command Room pane prompt input
- **Notes:** Register a global hotkey (configurable). On press: start Whisper recording in-process or via IPC to SigmaVoice. On release: inject transcribed text + run dictionary substitutions into the active pane's PTY input. This is the tightest competitive counter to BridgeVoice's core workflow.

### 5. Local/Cloud toggle for transcription backend
- **Value:** Medium — unlocks non-English speakers and improves accuracy for users with accented speech or technical vocabulary.
- **Effort:** M
- **Target:** SigmaVoice settings
- **Notes:** Add an optional cloud path (OpenAI Whisper API or future SigmaLink Cloud). Local remains the default and requires no account. Cloud requires API key. This also sets up the future LLM-reformatting (Custom Instructions) feature path.

---

## Confidence Notes

- **High confidence (visual confirmation):** Splash screen, Overview dashboard stats, multi-pane grid layout, Settings page Local/Cloud toggle, local model size list, Dictionary page with 4 saved entries, Custom Instructions textarea content (partially readable), Pricing page tiers and prices, floating BridgeVoice pill widget, @-mention autocomplete in Claude Code.
- **Medium confidence (verbal + partial visual):** Push-to-talk hotkey configuration (described verbally; settings for it not shown in a dedicated frame). Cloud backend provider (verbally implied to use an AI transcription service; vendor not named).
- **Low confidence / not shown:** Whether BridgeVoice has a recording waveform or silence-detection VAD. Whether there is a history export feature. Mobile/browser companion. API access for programmatic use.
- **Not shown:** BridgeMCP, BridgeCode, BridgeSpace advanced features — these are separate products mentioned only in passing.
