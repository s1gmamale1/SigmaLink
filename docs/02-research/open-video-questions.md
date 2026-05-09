# Open Video Questions

Things mentioned, glimpsed, or implied in the BridgeMind video corpus that I could not nail down with confidence in this pass. Each entry: **what's unclear** → **why it matters** → **next step**.

Conventions: same source codes as glossary (**L** launch / **V3** / **G54** / **AT**).

---

## A. Workspace types

1. **Bridge Canvas — what is it?**
   - V3 00:42 lists Bridge Canvas as a third workspace type alongside Bridge Space and Bridge Swarm. Never demoed in the videos pulled. Could be a node-graph view, a freeform whiteboard for orchestrating agents, or a Visual Design Tool entrypoint.
   - **Next**: pull the V3 video frames around `00:38–00:50` (the dropdown), or any later video that selects "Bridge Canvas".

2. **Single workspace preset**
   - AT 02:25 says "let's just do a single", implying a 1-pane preset alongside Squad/Team/Platoon/Legion/50. Not visually confirmed.

3. **Workspace presets — full list**
   - V3 00:48 references presets like "4 Claude code agents". Are presets a pre-defined library, or user-saveable templates? Are roster presets the same UI as workspace presets?
   - **Next**: a frame of the new-workspace dialog dropdown.

---

## B. Roster preset names & sizes

4. **Exact preset taxonomy**
   - Confirmed: `Squad = 5`, `Team ≈ 10`, `Platoon = 15`, `50 agents` (size only).
   - "Legion" appears in transcript ambiguously — is it the official label for the 15-agent preset or a colloquial term for "lots of agents"? G54 09:25.
   - Are there presets between 15 and 50? (e.g. Brigade, Battalion?)
   - **Next**: frame of the roster-preset dropdown.

5. **Per-role caps inside a preset**
   - Are role allocations within Squad / Team / Platoon fixed, or user-tweakable after picking the preset?
   - V3 06:10 implies tweakable (the demo customised provider per role); it's unclear whether you can also change the *count* per role.

---

## C. Pane / window chrome details

6. **Status dot colour mapping**
   - Each pane header has a small dot at the left. Colours not legible in 1080p thumbnails. Likely encodes idle / running / error / done. Need a clearer source.
   - **Next**: any closer-cropped screenshot from V3 / G54.

7. **`branch dev` indicator**
   - Every pane header in the launch thumbnail shows `ⵎ dev`. Is `dev` the literal git branch the pane's worktree is on, or a label of a worktree slot?
   - Implication for clone work: confirms BridgeSpace uses git worktrees (consistent with the supporting Emdash research).

8. **The `Agent X` label**
   - First pane is labelled `Agent X` (capital X), the rest are numbered `Agent 2`, `Agent 3`, etc. Is `X` literally the focused/active pane, or a placeholder rendered before naming?

9. **Agent-count pill colour rules**
   - The `(5)` and `(12)` pills on workspace tabs — what does the colour denote? In thumbnail they look the same warm amber. Hypothesis: amber = swarm running, blue = idle, but unverified.

10. **`+` to add new pane vs new workspace**
    - The `+` after the last tab is the new-workspace `+`. Is there a separate `+` for adding a new pane to an existing workspace?

---

## D. Operator Console rendering

11. **Per-agent message lanes — visual layout**
    - Stack vertical? Tabs across the top? Tree by role? Not visible in the saved thumbnails (the V3 thumbnail shows the *card grid*, not the chat).
    - **Next**: V3 chapter 08:00–11:13 or G54 12:35–14:15.

12. **Swarm card grid (V3 thumbnail) vs Operator Console**
    - The V3 thumbnail's right panel shows a **4×4 grid of agent cards**. Is that:
      (a) a different "swarm dashboard" view from the chat-style Operator Console, or
      (b) the Operator Console laid out as cards rather than a chat list?
    - Each card seems to show an agent's status at a glance. Layout token names to invent: `swarm-grid`, `agent-card`.

13. **Board section**
    - V3 09:30: scout posted a report into "scout one board section". Is there a per-agent panel where artefacts/files appear? How is it surfaced (file pane? message attachment?).

---

## E. Bridge agent (V3)

14. **Tools available to Bridge**
    - V3 02:10 says Bridge "has tools which we've built custom into the bridge agent so that it's actually able to take actions on your behalf, and it can even prompt agents for you." What's the tool set? At minimum: `launch_pane`, `prompt_agent`, `read_workspace_files`. Not enumerated in the video.

15. **Bridge model**
    - Which LLM powers Bridge? Not stated. Plausible: Claude Opus 4.6 (the daily-driver model in the videos) or a routing layer. Affects latency / cost story for a clone.

16. **Bridge invocation surface**
    - Is Bridge always-on in every Bridge Space, or only opened when the side-panel tab is clicked? Does Bridge appear in Bridge Swarm too?

---

## F. Visual Design Tool

17. **Activation gesture**
    - V3 11:30 jumps straight to selection. How is the Design Tool toggled on inside the browser tab? Hotkey? Toolbar button?

18. **Element-pick visualisation**
    - What does the marquee look like? Is it a Chrome devtools-style overlay? Brand colour on hover?

19. **Provider routing per prompt**
    - "I can also set it to whatever agent I want." What does the picker look like — dropdown, role-card row, or chip group?

20. **Drag-drop targets**
    - Confirmed: drop an MP4 onto a selection. Anything else accepted? Folder drops? Multiple files? Image-with-prompt for Gemini?

---

## G. Built-in IDE

21. **Editor depth**
    - The V3 IDE is described as a "slim VS Code". Does it support: syntax highlighting beyond plain text? Search? Multi-file tabs? LSP? Diff preview? Git integration? None visually confirmed.

22. **File tree**
    - Is there a file-explorer pane on the IDE side, or only a list of files opened from terminal clicks?

23. **Ownership of the file**
    - When an agent edits a file, does the IDE auto-refresh? Lock? Show a diff?

---

## H. Notification system (V3)

24. **Toast visual**
    - Audio "ding" confirmed; no visual confirmation of the toast/badge. Position? Colour? Clickable?

25. **Per-agent vs per-workspace notifications**
    - Does completion ding once per agent, once per swarm, or both? V3 03:44 implies per-agent.

---

## I. Voice (BridgeVoice / BridgeJarvis)

26. **Are they the same product or two layers?**
    - **BridgeVoice** ships in Pro plan; described as "voice-to-text".
    - **BridgeJarvis** ships in Basic plan; described as a "voice assistant that orchestrates all of those agents".
    - **Hypothesis**: BridgeVoice = STT primitive; BridgeJarvis = command-grammar/agent layer that routes voice to Bridge / swarm. Need a UI screenshot of each.

27. **Hotkey to start a voice prompt**
    - Push-to-talk? Hot-word? Click-mic-icon? Not stated.

---

## J. Browser tab

28. **Tab management UI**
    - "I can open up as many browsers I want" — does each browser get its own sub-tab inside the side panel, or do they tile?

29. **`@`-mention bindings**
    - V3 06:48: `@BridgeSpace Tauri` in a swarm prompt. Is `@` a global symbol that resolves to known projects/files/agents? Autocomplete dropdown?

---

## K. Worktrees / isolation

30. **`branch dev` evidence is good but partial**
    - Every pane in the launch thumbnail shows the same branch `dev`. Are panes on the *same* branch by default, or is `dev` just the demo's current branch? Multi-agent isolation usually wants per-pane branches; the supporting research report (`research_extracted.txt`) describes this. Need a frame where multiple panes show *different* branches to confirm.

---

## L. Pricing details

31. **Pro plan price**
    - V3 16:34 lists Pro plan features but the actual `$/mo` is not in the audio. Need to land on `bridgemind.ai/pricing` or grab the V3 frame at 16:35.

32. **Credits — what counts as a credit**
    - 5,000 vs 12,500 credits — is it tokens? agent-minutes? swarm-launches?

---

## M. Other channel videos that probably contain more BridgeSpace UI but were not pulled this pass

(Decision: prioritised V3, GPT5.4, AT because they were explicitly about BridgeSpace usage. The following are likely to add new frames if pulled. Spaced ≥ 5 s apart per yt-dlp loop to avoid 429.)

| Video ID | Title | Why useful |
|---|---|---|
| `dvRxOPXSeGQ` | 5 Things I've Learned After 154 Days Of Vibe Coding | Recap content typically reuses BridgeSpace screen-recordings of recent UI |
| `LC2bbkf-uo0` | Vibe Coding With Claude Code Desktop App | Likely contrasts BridgeSpace with Anthropic's desktop app |
| `ZwyGtjiHlp4` | Vibe Coding With Grok 4.3 in a Full Self Driving Tesla | Demonstrates BridgeSpace from a phone-tether scenario |
| `gViyPI7n-xo` | How Claude Code Stopped A DDoS Attack | Probably uses BridgeSpace swarms for incident response |
| `5GODcBhDX9U` | GPT 5.5 VS Claude Opus 4.7 | Side-by-side BridgeSpace panes |
| `jVFX-9kP6RQ` | Claude Opus 4.7 Is Complicated | Likely agent-team / Claude Code splash screens |
| `H7an7yS6bWo` | Vibe Coding With Qwen 3.6 Plus Preview For Free | New provider in BridgeSpace? |
| `ho3_WsLxmyA` | The Only GLM 5.1 Review You Need To Watch | Same |
| `rwCjrcoif7U` | Vibe Coding With Composer 2 | Same |
| `8X4G14JDwyM` | Vibe Coding With Claude Sonnet 4.6 | Same |
| `Urw7C7d6E_8` | I Cloned Myself Into a Hermes Agent | "Hermes Agent" as a provider in BridgeSpace? |
| `JKf-Zi5Y9Aw` | GPT 5.4 VS Opus 4.6 | Side-by-side BridgeSpace |
| `0_ggmG6f-sE` | Vibe Coding With Kimi K2.6 | New provider |
| `141n8k-5K14` | My OpenClaw Strategy Starts Today | Pulled — minimal BridgeSpace UI inside |
| `VplNyFNo2oI` | Officially Launching BridgeVoice | Will explicitly demo the voice surface (BridgeVoice vs BridgeJarvis question) |

Pulling all of these would probably **fully** answer the open questions above. The launch and V3 videos already cover ~80% of what a clone needs visually.

---

## N. Hard-to-recover items even with more videos

- **Exact pixel measurements** of margins, tab heights, etc. — only solvable by extracting individual frames at 1080p+ and pixel-picking. yt-dlp can pull the full mp4 if `ffmpeg` is installed (it is *not* in this environment, per the warnings); a single-frame extract via the storyboard mhtml is too low-res for pixel-level work. Recommend either:
  - install ffmpeg, redo `yt-dlp -f 18 …` and `ffmpeg -ss <t> -frames:v 1`, or
  - request the user record a 1-minute screen capture of their own BridgeSpace install.

- **Exact font** — confirming SF Mono vs JetBrains Mono vs Fira Code requires a screenshot of a glyph like `g` or `&` in the terminal. The 1080p crops are too small to disambiguate.

- **Motion / animation timing** — only recoverable from the video itself, not from VTT or thumbnail.
