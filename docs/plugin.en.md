# AI for Memory

Layered project memory for **DeepSeek Harness (DSH)**: six independent layers, five `aim_*` tools, a Web panel, conversation isolation, restorable context cleanup, BM25/SQL/RAG retrieval, conflict-checked knowledge, and risk-reviewed decisions — packaged as an installable DSH bundle.

> The Web panel is part of the plugin; its overview exposes the live memory counts, knowledge search, context policy and runtime status.

## What it keeps separate

| Layer | What it is | Why |
| --- | --- | --- |
| Process log (`staging`) | What just happened | Capture decisions, errors and UI facts one line at a time |
| Archive (`archive`) | Classified records | Make the process log reusable |
| Snapshots (`snapshots`) | Exact state objects | Restore a state later |
| Knowledge (`knowledge`) | One conclusion per record | Reviewable, searchable, exportable |
| Decisions (`decisions`) | Thesis / antithesis / risk review | Record why a high-risk choice was made |
| Contexts (`contexts`) | Full conversation archives | Clear old turns without losing the text |

JSON is the base. SQLite, RAG and exports are derived views; damaging a derived view cannot damage the JSON source. Model-written knowledge starts as **unverified** and is down-ranked in retrieval until the user confirms it.

## Retrieval and context

- `aim_search` uses lexical BM25 offline; SQL handles counts, aggregations and exact IDs; RAG adds vector recall when both Embedding and Rerank are configured.
- RAG results and BM25 results are fused with RRF, so an old document hidden by semantic de-duplication is still reachable through the lexical channel.
- Context cleanup archives a full turn before replacing it. When usage reaches the configured threshold, completed turns are hard-reset and a short task brief is reloaded before the next request; if the turn ends with no next request, the old window is cleared at once.
- Conversations are private by default. Cross-conversation retrieval only sees conversations the user has explicitly opened, plus the shared layer.

## Install

Install the bundle from the DSH plugin market, or load this repository as a local plugin. The plugin has no runtime dependencies beyond Node.js built-ins. Node.js **20 or newer** is required.

```bash
npm test          # runs test/core.test.mjs
```

CI runs the same suite on Linux, Windows and macOS with Node 20 and 22.

## Privacy

All memory stays in the local memory directory by default. Network sync is off until enabled. External model calls only go to the endpoint configured in the panel; API keys are stored locally and are never returned to the browser.

See [README.md](../README.md) and the [docs](../docs) directory for the full Chinese documentation.
