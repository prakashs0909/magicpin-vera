/**
 * composer.js
 * Core composition engine for Vera — the magicpin merchant AI assistant.
 *
 * Takes 4 contexts (category, merchant, trigger, customer) and produces
 * a WhatsApp message that scores high across 5 judge dimensions:
 *   1. Specificity     — concrete numbers, dates, citations
 *   2. Category fit    — voice/vocabulary matches the vertical
 *   3. Merchant fit    — personalized to THIS merchant's state
 *   4. Trigger relevance — clearly explains WHY NOW
 *   5. Engagement compulsion — one of 8 levers drives the reply
 */

import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ---------------------------------------------------------------------------
// LLM CLIENT SETUP
// ---------------------------------------------------------------------------

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function callLLM(systemPrompt, userPrompt) {
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    generationConfig: {
      temperature: 0,           // Deterministic — required by brief §7.1
      responseMimeType: 'application/json',
    },
    systemInstruction: systemPrompt,
  });

  const result = await model.generateContent(userPrompt);
  return result.response.text().trim();
}

// ---------------------------------------------------------------------------
// SYSTEM PROMPT (shared base — injected for every trigger kind)
// ---------------------------------------------------------------------------

const BASE_SYSTEM_PROMPT = `You are Vera, magicpin's merchant AI assistant on WhatsApp.
Your ONLY job is to compose ONE high-quality WhatsApp message that will engage an Indian merchant.

HARD RULES (violating any = score 0 for that dimension):
1. NO generic phrases: "increase your sales", "grow your business", "amazing deal", "flat X% off"
2. USE service+price format: "Dental Cleaning @ ₹299", "Haircut @ ₹149" — NEVER "X% off"
3. ONE primary CTA — binary YES/STOP for action triggers, or a single open question for info triggers
4. NEVER fabricate data not present in the contexts (no fake research, no made-up competitors)
5. NEVER re-introduce yourself after turn 1
6. NO long preamble — "I hope you're doing well" is penalized
7. Match language preference: hi-en mix = natural Hindi-English code-mix
8. Use PEER tone, not promotional. Dentists/doctors get clinical language. Salons get warm/lifestyle.
9. Keep it concise — WhatsApp messages, not emails
10. CTA lands in the LAST sentence
11. STRICT LENGTH LIMIT: The message body must be strictly under 320 characters.

COMPULSION LEVERS (use at least 1 per message):
- Specificity: concrete number, date, source citation ("JIDA Oct 2026 p.14", "2,100 patients", "38% better")
- Loss aversion: "X patients haven't heard from you in 6+ months"
- Social proof: "3 dental clinics in your locality added posts this week"
- Effort externalization: "I've already drafted X — just say YES"
- Curiosity gap: "Want to see exactly who?"
- Reciprocity: "Noticed something in your profile — thought you'd want to know"
- Binary commitment: Reply YES / STOP

OUTPUT FORMAT (JSON only — no markdown, no prose outside JSON):
{
  "body": "the full WhatsApp message (strictly under 320 characters)",
  "cta": "open_ended" | "binary_yes_stop" | "none",
  "send_as": "vera" | "merchant_on_behalf",
  "suppression_key": "unique dedup key",
  "rationale": "1-2 sentences explaining why this message, what lever it uses"
}`;

// ---------------------------------------------------------------------------
// TRIGGER-KIND PROMPT BUILDERS
// Each returns a user-prompt string with the relevant contexts structured in.
// ---------------------------------------------------------------------------

const TRIGGER_PROMPTS = {

  research_digest: (cat, merchant, trigger, customer) => {
    const topItem = resolveDigestItem(cat, trigger);
    return `TRIGGER: A new research/digest item is available relevant to this merchant.
TRIGGER KIND: research_digest

CATEGORY CONTEXT:
- Slug: ${cat.slug}
- Voice: ${cat.voice?.tone} (code-mix: ${cat.voice?.code_mix || 'hindi_english_natural'})
- Taboo words: ${(cat.voice?.vocab_taboo || []).join(', ')}

MERCHANT CONTEXT:
- Name: ${merchant.identity?.name}
- City/Locality: ${merchant.identity?.locality}, ${merchant.identity?.city}
- Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
- CTR (30d): ${merchant.performance?.ctr} vs peer median ${cat.peer_stats?.avg_ctr}
- Signals: ${(merchant.signals || []).join(', ')}
- Customer aggregate: ${JSON.stringify(merchant.customer_aggregate || {})}
- Active offers: ${(merchant.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}
- Recent convo: ${merchant.conversation_history?.slice(-1)?.[0]?.body || 'none'}

DIGEST ITEM:
- Title: ${topItem?.title || trigger.payload?.top_item_id}
- Source: ${topItem?.source || 'unknown'}
- Trial N: ${topItem?.trial_n || ''}
- Patient segment: ${topItem?.patient_segment || ''}
- Summary: ${topItem?.summary || ''}
- Actionable: ${topItem?.actionable || ''}

TASK: Write a WhatsApp message to the MERCHANT (not the customer) sharing this research.
Anchor on verifiable numbers (trial_n, %, source page). Peer/clinical tone. 
Ask if they want you to pull it and draft patient-education content.`;
  },

  regulation_change: (cat, merchant, trigger, customer) => {
    const item = resolveDigestItem(cat, trigger);
    const deadline = trigger.payload?.deadline_iso || item?.date || 'upcoming';
    return `TRIGGER: A regulatory change affects this merchant's category.
TRIGGER KIND: regulation_change

CATEGORY: ${cat.slug} | Voice: ${cat.voice?.tone}
MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Signals: ${(merchant.signals || []).join(', ')}

REGULATION ITEM:
- Title: ${item?.title || trigger.payload?.top_item_id}
- Source: ${item?.source || 'unknown'}
- Deadline: ${deadline}
- Summary: ${item?.summary || ''}
- Actionable: ${item?.actionable || ''}

TASK: Compose a compliance nudge. Urgency is real but not alarming. Peer tone.
Frame as "heads up from a colleague, here's what you need to do before [deadline]".
If there's an actionable step, offer to help them complete it.`;
  },

  perf_dip: (cat, merchant, trigger, customer) => {
    const { metric, delta_pct, window, vs_baseline } = trigger.payload || {};
    const dipPct = Math.abs(delta_pct * 100).toFixed(0);
    return `TRIGGER: Merchant's performance has dropped significantly.
TRIGGER KIND: perf_dip

CATEGORY: ${cat.slug} | Peer avg CTR: ${cat.peer_stats?.avg_ctr}
MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.locality}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Subscription: ${merchant.subscription?.status}, ${merchant.subscription?.days_remaining}d remaining

PERFORMANCE DATA:
- ${metric} dropped ${dipPct}% in last ${window}
- Baseline was: ${vs_baseline || 'historical avg'}
- 30d views: ${merchant.performance?.views}, calls: ${merchant.performance?.calls}, CTR: ${merchant.performance?.ctr}
- Peer avg CTR: ${cat.peer_stats?.avg_ctr}
- Active offers: ${(merchant.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}
- Signals: ${(merchant.signals || []).join(', ')}

TASK: Use LOSS AVERSION framing. Specific numbers. Offer one actionable step Vera can execute for them.
Example frame: "Your calls dropped 50% this week vs avg — main issue likely X. Main hoon — chalega?"`;
  },

  perf_spike: (cat, merchant, trigger, customer) => {
    const { metric, delta_pct, window } = trigger.payload || {};
    const spikePct = Math.abs((delta_pct || 0) * 100).toFixed(0);
    return `TRIGGER: Merchant's performance spiked positively.
TRIGGER KIND: perf_spike

MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
${metric} up ${spikePct}% in ${window || '7d'}
30d views: ${merchant.performance?.views}, CTR: ${merchant.performance?.ctr}
Peer avg CTR: ${cat.peer_stats?.avg_ctr}
Active offers: ${(merchant.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}

TASK: Celebrate the win + capitalize on momentum. Curiosity lever: 
"Your views spiked 28% — want to see what's driving it? I can draft a post to keep the momentum."`;
  },

  renewal_due: (cat, merchant, trigger, customer) => {
    const { days_remaining, plan, renewal_amount } = trigger.payload || {};
    const daysLeft = days_remaining || merchant.subscription?.days_remaining;
    return `TRIGGER: Merchant's magicpin subscription is expiring soon.
TRIGGER KIND: renewal_due

MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Subscription: ${plan || merchant.subscription?.plan}, ${daysLeft} days remaining
Renewal amount: ₹${renewal_amount || '?'}
30d views: ${merchant.performance?.views}, calls: ${merchant.performance?.calls}
Signals: ${(merchant.signals || []).join(', ')}

TASK: Loss aversion + social proof. Show what they'll lose. Specific numbers.
Frame: "In last 30d you got X views, Y calls via magicpin. [N] days left on your ${plan} plan."
Single binary CTA (YES / STOP).`;
  },

  milestone_reached: (cat, merchant, trigger, customer) => {
    const milestone = trigger.payload?.milestone || '100 reviews';
    return `TRIGGER: Merchant reached a positive milestone.
TRIGGER KIND: milestone_reached

MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Milestone: ${milestone}
30d views: ${merchant.performance?.views}, CTR: ${merchant.performance?.ctr}

TASK: Celebrate + use reciprocity lever. Acknowledge achievement, then offer next step.
Keep it warm and short. Use the merchant's name.`;
  },

  dormant_with_vera: (cat, merchant, trigger, customer) => {
    const lastMsg = merchant.conversation_history?.slice(-1)?.[0]?.body;
    return `TRIGGER: Merchant hasn't replied to Vera in 14+ days.
TRIGGER KIND: dormant_with_vera

MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Last Vera message: "${lastMsg || 'unknown'}"
30d performance: views ${merchant.performance?.views}, CTR ${merchant.performance?.ctr}
Offers active: ${(merchant.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}
Signals: ${(merchant.signals || []).join(', ')}
Category offers available: ${cat.offer_catalog?.slice(0, 3).map(o => o.title).join(', ')}

TASK: Re-engagement with CURIOSITY lever. Don't nag. Ask ONE interesting question about their business.
Or share ONE specific insight about their profile they can verify immediately.
"Noticed X — thought you'd want to know. Worth 30 seconds?"`;
  },

  review_theme_emerged: (cat, merchant, trigger, customer) => {
    const { theme, occurrences_30d, trend, common_quote } = trigger.payload || {};
    const merchantTheme = merchant.review_themes?.find(t => t.theme === theme);
    const quote = common_quote || merchantTheme?.common_quote || '';
    return `TRIGGER: A review theme has emerged (multiple reviews mention the same topic).
TRIGGER KIND: review_theme_emerged

MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Review theme: "${theme}" — ${occurrences_30d} occurrences in 30d, trend: ${trend}
Common quote from customers: "${quote}"
Merchant's existing review themes: ${JSON.stringify(merchant.review_themes || [])}

TASK: Surface the pattern (merchant may not have noticed). Peer/colleague tone.
If negative: frame as opportunity, offer to draft a response template.
If positive: amplify — offer to feature it in their GBP description.`;
  },

  competitor_opened: (cat, merchant, trigger, customer) => {
    const { distance_km, competitor_name } = trigger.payload || {};
    return `TRIGGER: A new competitor opened nearby.
TRIGGER KIND: competitor_opened

MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.locality}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Competitor: ${competitor_name || 'a new ' + cat.slug.slice(0, -1)} opened ${distance_km || '?'} km away
Merchant CTR: ${merchant.performance?.ctr} vs peer ${cat.peer_stats?.avg_ctr}
Active offers: ${(merchant.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}

TASK: Proactive competitive awareness. Not alarmist — peer tone.
Frame: "Heads up — new [category] ${distance_km}km away. Let's make sure your GBP listing is sharper."
Offer one concrete step.`;
  },

  festival_upcoming: (cat, merchant, trigger, customer) => {
    const { festival, date, days_until } = trigger.payload || {};
    const relevantOffer = cat.offer_catalog?.[0]?.title;
    return `TRIGGER: A major Indian festival is upcoming — relevant for merchant campaigns.
TRIGGER KIND: festival_upcoming

MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Festival: ${festival}, on ${date} (${days_until} days away)
Category: ${cat.slug}
Relevant category offer: ${relevantOffer || 'none'}
Active merchant offers: ${(merchant.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}

TASK: Timely campaign nudge. Make it feel like the right moment.
Offer to draft a festival-specific GBP post and WhatsApp offer.
Use the festival name, the timeline, and effort externalization ("I've drafted X").`;
  },

  recall_due: (cat, merchant, trigger, customer) => {
    const { service_due, last_service_date, due_date, available_slots } = trigger.payload || {};
    const slots = (available_slots || []).slice(0, 2).map(s => s.label).join(' ya ');
    return `TRIGGER: A customer's service recall is due (send on behalf of merchant TO customer).
TRIGGER KIND: recall_due
SEND_AS: merchant_on_behalf (NOT vera — this is from the merchant's phone to their customer)

MERCHANT: ${merchant.identity?.name}
Active offer: ${(merchant.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}

CUSTOMER: ${customer?.identity?.name || 'Customer'}
Language preference: ${customer?.identity?.language_pref || 'en'}
State: ${customer?.state || 'unknown'}
Last visit: ${customer?.relationship?.last_visit || last_service_date}
Services received: ${(customer?.relationship?.services_received || []).join(', ')}
Consent scope: ${(customer?.consent?.scope || []).join(', ')}
Preferred slots: ${customer?.preferences?.preferred_slots || 'any'}

RECALL INFO:
- Service due: ${service_due || '6-month recall'}
- Due date: ${due_date || 'now'}
- Available slots: ${slots || 'please call to book'}

TASK: Compose a SHORT WhatsApp from the merchant to the customer.
- NO vera introduction — it's from the merchant
- Name the customer, name the merchant clinic
- Mention months since last visit
- Offer slots (numbered for easy reply: "Reply 1 for X, 2 for Y")
- Language: match customer's language_pref`;
  },

  customer_lapsed_soft: (cat, merchant, trigger, customer) => {
    const monthsLapsed = customer?.state === 'lapsed_soft' ? '3-6' : '6+';
    const activeOffer = (merchant.offers || []).filter(o => o.status === 'active')[0]?.title;
    return `TRIGGER: A customer hasn't visited in ${monthsLapsed} months — soft lapse.
TRIGGER KIND: customer_lapsed_soft
SEND_AS: merchant_on_behalf

MERCHANT: ${merchant.identity?.name}
Active offer: ${activeOffer || cat.offer_catalog?.[0]?.title || 'none'}

CUSTOMER: ${customer?.identity?.name || 'Customer'}
Language: ${customer?.identity?.language_pref || 'en'}
State: ${customer?.state}
Last visit: ${customer?.relationship?.last_visit}
Services: ${(customer?.relationship?.services_received || []).join(', ')}
Visits total: ${customer?.relationship?.visits_total}
Consent: ${(customer?.consent?.scope || []).join(', ')}

TASK: Gentle win-back message from merchant to customer. Warm, not pushy.
Mention the specific service they usually get. Make it personal. ONE CTA.`;
  },

  appointment_tomorrow: (cat, merchant, trigger, customer) => {
    return `TRIGGER: A customer has an appointment tomorrow.
TRIGGER KIND: appointment_tomorrow
SEND_AS: merchant_on_behalf

MERCHANT: ${merchant.identity?.name}
CUSTOMER: ${customer?.identity?.name || 'Customer'}
Language: ${customer?.identity?.language_pref || 'en'}
Appointment: tomorrow
Services to expect: ${(customer?.relationship?.services_received || []).slice(-1)[0] || 'visit'}

TASK: Appointment reminder message. Friendly, concise. Include any prep instructions relevant to the service.
Confirm the time if available. End with "Looking forward to seeing you 🙂"`;
  },

  curious_ask_due: (cat, merchant, trigger, customer) => {
    return `TRIGGER: Weekly curiosity-driven conversation starter to keep merchant engaged.
TRIGGER KIND: curious_ask_due

MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Category: ${cat.slug}
Signals: ${(merchant.signals || []).join(', ')}
30d views: ${merchant.performance?.views}
Trend signals: ${JSON.stringify(cat.trend_signals?.slice(0, 2) || [])}

TASK: Ask ONE genuine, specific, curiosity-driven question about their business.
Examples: "What's your most-asked service this week?", "Have you noticed more walk-ins after that post?"
NOT a pitch. NOT a generic check-in. A question that makes them THINK and want to reply.
No CTA — just the question.`;
  },

  winback_eligible: (cat, merchant, trigger, customer) => {
    const { days_since_expiry, perf_dip_pct, lapsed_customers_added_since_expiry } = trigger.payload || {};
    return `TRIGGER: Merchant's subscription expired; they're eligible for win-back.
TRIGGER KIND: winback_eligible

MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Days since expiry: ${days_since_expiry}
Performance since expiry: ${Math.abs((perf_dip_pct || 0) * 100)}% dip
Lapsed customers added since expiry: ${lapsed_customers_added_since_expiry}

TASK: Loss aversion framing — what they've missed since leaving.
Specific numbers. Offer to restart immediately. Binary YES / STOP.`;
  },

};

// Default for unknown trigger kinds
const DEFAULT_TRIGGER_PROMPT = (cat, merchant, trigger, customer) => {
  return `TRIGGER KIND: ${trigger.kind} (custom)
MERCHANT: ${merchant.identity?.name}, ${merchant.identity?.city}
Languages: ${(merchant.identity?.languages || ['en']).join(', ')}
Category: ${cat.slug}
Trigger payload: ${JSON.stringify(trigger.payload || {})}
Signals: ${(merchant.signals || []).join(', ')}
Performance: views ${merchant.performance?.views}, CTR ${merchant.performance?.ctr}
Active offers: ${(merchant.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}
TASK: Compose an engaging, specific WhatsApp message based on this trigger.`;
};

// ---------------------------------------------------------------------------
// HELPER: resolve a digest item from category context given a trigger
// ---------------------------------------------------------------------------

function resolveDigestItem(cat, trigger) {
  const topItemId = trigger.payload?.top_item_id;
  if (!topItemId || !cat.digest) return null;
  return cat.digest.find(d => d.id === topItemId) || cat.digest[0] || null;
}

// ---------------------------------------------------------------------------
// POST-LLM VALIDATION + REPAIR
// ---------------------------------------------------------------------------

function validateAndRepair(raw, trigger, merchant) {
  let parsed;
  try {
    // Strip markdown fences if present
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // Last resort: extract JSON with regex
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }

  if (!parsed) {
    console.error('[validateAndRepair] JSON parse failed. Raw LLM response was:', raw);
    // Fallback structure if LLM returned garbage
    return {
      body: `Hi ${merchant.identity?.name}, quick update from Vera. Reply YES to continue or STOP to opt out.`,
      cta: 'binary_yes_stop',
      send_as: 'vera',
      suppression_key: `fallback:${trigger.id}:${Date.now()}`,
      rationale: 'Fallback due to LLM parse error',
    };
  }

  // Normalize CTA field
  const ctaRaw = (parsed.cta || '').toLowerCase();
  if (ctaRaw.includes('binary') || ctaRaw.includes('yes') || ctaRaw.includes('stop')) {
    parsed.cta = 'binary_yes_stop';
  } else if (ctaRaw === 'none' || ctaRaw === '') {
    parsed.cta = 'none';
  } else {
    parsed.cta = 'open_ended';
  }

  // Ensure suppression_key is set
  if (!parsed.suppression_key) {
    parsed.suppression_key = trigger.suppression_key || `${trigger.kind}:${merchant.merchant_id}:${Date.now()}`;
  }

  // Ensure send_as is valid
  if (!['vera', 'merchant_on_behalf'].includes(parsed.send_as)) {
    parsed.send_as = trigger.scope === 'customer' ? 'merchant_on_behalf' : 'vera';
  }

  // Ensure body is non-empty
  if (!parsed.body || parsed.body.trim().length === 0) {
    parsed.body = `Hi ${merchant.identity?.name}, Vera here. Reply YES to continue.`;
  }

  // Enforce 320-character limit
  if (parsed.body && parsed.body.length > 320) {
    parsed.body = parsed.body.slice(0, 317) + '...';
  }

  // Ensure rationale is present
  if (!parsed.rationale) {
    parsed.rationale = `Composed for trigger kind: ${trigger.kind}`;
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// MAIN COMPOSE FUNCTION
// ---------------------------------------------------------------------------

/**
 * Compose a WhatsApp message given the 4 contexts.
 *
 * @param {object} category   - CategoryContext payload
 * @param {object} merchant   - MerchantContext payload
 * @param {object} trigger    - TriggerContext payload
 * @param {object|null} customer - CustomerContext payload (optional)
 * @returns {Promise<object>} - { body, cta, send_as, suppression_key, rationale }
 */
export async function compose(category, merchant, trigger, customer = null) {
  // Select the right prompt builder for this trigger kind
  const promptBuilder = TRIGGER_PROMPTS[trigger.kind] || DEFAULT_TRIGGER_PROMPT;
  const userPrompt = promptBuilder(category, merchant, trigger, customer);

  // Call LLM
  const raw = await callLLM(BASE_SYSTEM_PROMPT, userPrompt);

  // Validate + repair output
  const composed = validateAndRepair(raw, trigger, merchant);

  return composed;
}

// ---------------------------------------------------------------------------
// REPLY COMPOSER (for multi-turn conversations)
// ---------------------------------------------------------------------------

const REPLY_MERCHANT_SYSTEM_PROMPT = `You are Vera, magicpin's merchant AI assistant.
You are in a MULTI-TURN conversation with a merchant. Respond to their latest message.

RULES:
1. If they say YES/accept/chalega/go ahead/okay — switch to ACTION mode immediately. Do not ask qualifying questions. Report the action taken (e.g., "I've updated your hours" or "I've drafted the offer and scheduled it for you!").
2. If they ask a question — answer it specifically with data from contexts (e.g. peer stats, active offers, category guidelines).
3. If they say NO/stop/not interested/busy — gracefully end: "Samajh gayi, bilkul theek hai. Kabhi zaroorat ho toh main hoon. Best wishes! 🙏"
4. Keep it SHORT — 1-3 sentences max for a reply.
5. Match the language/tone of the merchant's message.
6. Support STOP / opt-out immediately by ending the conversation.
7. Decline off-topic requests politely but firmly (e.g., if they ask for help with GST or personal questions: "Maafi chahungi, main sirf magicpin and Google profile related tasks mein help kar sakti hoon. Iske baare mein main nahi bata paungi.").
8. STRICT LENGTH LIMIT: The reply body must be strictly under 320 characters.

OUTPUT FORMAT (JSON only):
{
  "action": "send" | "wait" | "end",
  "body": "your reply (only when action=send)",
  "cta": "open_ended" | "binary_yes_stop" | "none",
  "wait_seconds": 1800,
  "rationale": "why this response"
}`;

const REPLY_CUSTOMER_SYSTEM_PROMPT = `You are the AI assistant for a merchant, replying to their customer on WhatsApp on behalf of the merchant.
Speak as the business itself (e.g., "Dr. Meera's Dental Clinic" or "our clinic/salon"). Never introduce yourself as Vera.

RULES:
1. Confirm bookings: If the customer selected a slot (e.g., "Wed 5 Nov, 6pm") or asked to book, confirm the slot clearly using the details from the slot option they picked.
2. If they ask a question about services/prices, answer using the merchant context and category catalogs. No fabrication.
3. Be professional, warm, and concise (1-2 sentences).
4. Match the language preference/tone of the customer's message (natural code-mix of Hindi/English is common and encouraged if they write in it).
5. STRICT LENGTH LIMIT: The reply body must be strictly under 320 characters.

OUTPUT FORMAT (JSON only):
{
  "action": "send" | "wait" | "end",
  "body": "your reply text (only when action=send)",
  "cta": "none" | "open_ended" | "binary_yes_stop",
  "rationale": "short explanation of the response"
}`;

/**
 * Compose a reply for a multi-turn conversation.
 *
 * @param {object} state - Conversation state (history, contexts, signals, isCustomerFacing)
 * @param {string} incomingMessage - The latest message received (from merchant or customer)
 * @returns {Promise<object>} - { action, body, cta, rationale } or { action: 'wait' } or { action: 'end' }
 */
export async function composeReply(state, incomingMessage) {
  const { category, merchant, trigger, customer, history, isCustomerFacing } = state;

  const systemPrompt = isCustomerFacing ? REPLY_CUSTOMER_SYSTEM_PROMPT : REPLY_MERCHANT_SYSTEM_PROMPT;

  // Build context summary for reply
  let contextSummary = '';
  if (isCustomerFacing) {
    contextSummary = `
MERCHANT: ${merchant?.identity?.name || 'Unknown'}, ${merchant?.identity?.city || ''}
CATEGORY: ${category?.slug || 'unknown'}
CUSTOMER: ${customer?.identity?.name || 'Customer'}
CUSTOMER CONTEXT:
- Preferences/Preferred slots: ${customer?.preferences?.preferred_slots || 'any'}
- Relationship/Services received: ${(customer?.relationship?.services_received || []).join(', ') || 'none'}
- Active merchant offers: ${(merchant?.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}

CONVERSATION SO FAR:
${history.map(h => `  [${h.from}]: ${h.body}`).join('\n')}

CUSTOMER JUST SAID: "${incomingMessage}"
`.trim();
  } else {
    contextSummary = `
MERCHANT: ${merchant?.identity?.name || 'Unknown'}, ${merchant?.identity?.city || ''}
CATEGORY: ${category?.slug || 'unknown'}
CONVERSATION SO FAR:
${history.map(h => `  [${h.from}]: ${h.body}`).join('\n')}

MERCHANT JUST SAID: "${incomingMessage}"

MERCHANT CONTEXT:
- Active offers: ${(merchant?.offers || []).filter(o => o.status === 'active').map(o => o.title).join(', ') || 'none'}
- Signals: ${(merchant?.signals || []).join(', ')}
- Subscription: ${merchant?.subscription?.status}, ${merchant?.subscription?.days_remaining}d left
`.trim();
  }

  const raw = await callLLM(systemPrompt, contextSummary);

  let parsed;
  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { parsed = JSON.parse(match[0]); } catch { parsed = null; }
    }
  }

  if (!parsed) {
    return {
      action: 'send',
      body: isCustomerFacing 
        ? 'Got it! Confirming and updating details for you.' 
        : 'Got it! Main aapke liye check karti hoon aur update karti hoon.',
      cta: 'none',
      rationale: 'Fallback reply due to parse error',
    };
  }

  // Ensure body is under 320 chars
  if (parsed.body && parsed.body.length > 320) {
    parsed.body = parsed.body.slice(0, 317) + '...';
  }

  return parsed;
}
