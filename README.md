# Vera — magicpin AI Challenge Submission

**Team**: Vera AI  
**Stack**: Node.js + Express + Google Gemini 1.5 Flash  
**Bot URL**: `http://localhost:8080` (or your deployed URL)

---

## Approach

### Architecture

```
Judge Harness ──HTTP──► Express Server (bot.js)
                              │
              ┌───────────────┼──────────────────┐
              │               │                  │
        Context Store   Composer Engine   Conversation Manager
        (in-memory Map) (composer.js)    (conversationHandler.js)
              │               │                  │
              └───────────────┘          AutoReplyDetector.js
                    │
              Gemini 1.5 Flash (LLM)
```

### Key Design Decisions

**1. Trigger-Kind Routing**  
Instead of one generic prompt, each `trigger.kind` gets a specialized prompt template in `composer.js`. This yields dramatically better specificity and trigger relevance scores — a `research_digest` trigger gets a peer-clinical framing, while a `perf_dip` trigger gets loss-aversion framing with the merchant's actual numbers.

**2. Compulsion Lever Coverage**  
Every trigger-kind prompt is engineered to hit at least one of the 8 compulsion levers (specificity, loss aversion, social proof, effort externalization, curiosity, reciprocity, direct ask, binary CTA). Production Vera misses social proof and direct asking — we address both.

**3. Auto-Reply Detection on Turn 1**  
`autoReplyDetector.js` uses pattern matching + verbatim-repeat detection to catch WhatsApp Business canned auto-replies immediately, without burning 2-3 turns. After one retry attempt, Vera exits gracefully ("Koi baat nahi, samajh gayi. Best wishes!").

**4. Intent Transition Guard**  
`conversationHandler.js` classifies every merchant message for accept/reject/question intent. If `accept` is detected while in `pitching` phase, the bot immediately switches to `acting` phase — no more re-qualifying questions (the Pattern D failure in production Vera).

**5. Post-LLM Validation**  
Every LLM response is validated and repaired: CTA normalized to `binary_yes_stop | open_ended | none`, `send_as` inferred from trigger scope, body length checked. Prevents `-2` malformed response penalties.

**6. Temperature = 0**  
Deterministic output as required by the brief §7.1.

---

## What additional context would have helped most

1. **Real conversation logs by trigger kind** — knowing which trigger kinds actually drive replies vs. which ones merchants ignore would have informed prompt engineering far more than the ~5 example conversations in the brief.
2. **Category-specific voice anti-patterns** — e.g., the exact phrases that sound "too salesy" for dentists vs. what's acceptable for restaurants.
3. **Suppression window rules** — the brief says suppression_key prevents dedup, but doesn't specify the exact time window before the same key can fire again.

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Set your API key
echo "GEMINI_API_KEY=your_key_here" >> .env

# 3. Generate the expanded dataset (requires Python)
cd ../magicpin-ai-challenge/dataset
python generate_dataset.py --out ./expanded
cd ../../proj

# 4. Start the bot
npm start

# 5. Run the judge simulator (from challenge dir)
cd ../magicpin-ai-challenge
python judge_simulator.py
```

---

## Tradeoffs

| Decision | Upside | Downside |
|---|---|---|
| Gemini Flash over GPT-4o | 2-3× faster, stays inside 30s timeout | Slightly less nuanced instruction following |
| In-memory state | Zero infra, zero latency | Wiped on restart (acceptable for 60-min test) |
| Trigger-kind router | Much better specificity per trigger | More prompt code to maintain |
| Single compose call per trigger | Simple, fast | Can't chain multiple ideas per message |
