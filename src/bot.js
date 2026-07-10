/**
 * bot.js — Vera AI Bot Server
 * magicpin AI Challenge — merchant AI assistant
 *
 * Exposes 5 endpoints as required by the judge harness:
 *   GET  /v1/healthz      — liveness probe
 *   GET  /v1/metadata     — bot identity
 *   POST /v1/context      — receive context pushes (category/merchant/customer/trigger)
 *   POST /v1/tick         — periodic wake-up; bot decides what to proactively send
 *   POST /v1/reply        — handle merchant/customer reply in a conversation
 *
 * Also handles:
 *   POST /v1/teardown     — optional; wipes state at end of test
 */

import 'dotenv/config';
import express from 'express';
import { compose } from './composer.js';
import { ConversationManager } from './conversationHandler.js';

const app = express();
app.use(express.json({ limit: '512kb' }));

const PORT = process.env.PORT || 8080;
const START_TIME = Date.now();

// ---------------------------------------------------------------------------
// IN-MEMORY STATE
// ---------------------------------------------------------------------------

/**
 * Context store: (scope, context_id) → { version, payload }
 * Scope values: "category" | "merchant" | "customer" | "trigger"
 */
const contexts = new Map(); // key: `${scope}::${context_id}`

/**
 * Conversation state: conversation_id → ConversationState
 */
const conversations = new Map();

/**
 * Suppression tracker: suppression_key → boolean
 * Prevents sending duplicate messages for the same trigger.
 */
const suppressionKeys = new Set();

const conversationManager = new ConversationManager(conversations);

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function ctxKey(scope, contextId) {
  return `${scope}::${contextId}`;
}

function getCtx(scope, contextId) {
  return contexts.get(ctxKey(scope, contextId))?.payload || null;
}

function countByScope() {
  const counts = { category: 0, merchant: 0, customer: 0, trigger: 0 };
  for (const key of contexts.keys()) {
    const scope = key.split('::')[0];
    if (scope in counts) counts[scope]++;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// GET /v1/healthz
// ---------------------------------------------------------------------------

app.get('/v1/healthz', (req, res) => {
  res.json({
    status: 'ok',
    uptime_seconds: Math.floor((Date.now() - START_TIME) / 1000),
    contexts_loaded: countByScope(),
  });
});

// ---------------------------------------------------------------------------
// GET /v1/metadata
// ---------------------------------------------------------------------------

app.get('/v1/metadata', (req, res) => {
  res.json({
    team_name: 'Vera AI',
    team_members: ['Prakash'],
    model: 'gemini-1.5-flash',
    approach:
      'Trigger-kind router + specialized prompt templates + LLM composition. ' +
      'Post-LLM validation for CTA shape and language. ' +
      'Multi-turn auto-reply detection + intent transition handling.',
    contact_email: 'prakash@example.com',
    version: '1.0.0',
    submitted_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/context
// ---------------------------------------------------------------------------

app.post('/v1/context', (req, res) => {
  const { scope, context_id, version, payload, delivered_at } = req.body || {};

  // Validate required fields
  const validScopes = ['category', 'merchant', 'customer', 'trigger'];
  if (!scope || !validScopes.includes(scope)) {
    return res.status(400).json({
      accepted: false,
      reason: 'invalid_scope',
      details: `scope must be one of: ${validScopes.join(', ')}`,
    });
  }
  if (!context_id || version === undefined || !payload) {
    return res.status(400).json({
      accepted: false,
      reason: 'missing_fields',
      details: 'context_id, version, and payload are required',
    });
  }

  const key = ctxKey(scope, context_id);
  const existing = contexts.get(key);

  // Idempotency: reject stale versions
  if (existing && existing.version > version) {
    return res.status(409).json({
      accepted: false,
      reason: 'stale_version',
      current_version: existing.version,
    });
  }

  // Idempotency: same version = no-op but still 200
  if (existing && existing.version === version) {
    return res.json({
      accepted: true,
      ack_id: `ack_${context_id}_v${version}_dup`,
      stored_at: new Date().toISOString(),
      note: 'duplicate_ignored',
    });
  }

  // Store new or updated context
  contexts.set(key, { version, payload, received_at: delivered_at || new Date().toISOString() });

  return res.json({
    accepted: true,
    ack_id: `ack_${context_id}_v${version}`,
    stored_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /v1/tick
// ---------------------------------------------------------------------------

app.post('/v1/tick', async (req, res) => {
  const { now, available_triggers = [] } = req.body || {};

  const actions = [];
  const nowDate = now ? new Date(now) : new Date();

  // Process available triggers — compose a message for each eligible one
  for (const trgId of available_triggers) {
    // Cap at 20 actions per tick (per spec)
    if (actions.length >= 20) break;

    const trigger = getCtx('trigger', trgId);
    if (!trigger) continue;

    // Skip if suppression key already fired
    const suppKey = trigger.suppression_key;
    if (suppKey && suppressionKeys.has(suppKey)) continue;

    // Skip expired triggers
    if (trigger.expires_at && new Date(trigger.expires_at) < nowDate) continue;

    // Resolve merchant and category
    const merchantId = trigger.merchant_id;
    if (!merchantId) continue;

    const merchant = getCtx('merchant', merchantId);
    if (!merchant) continue;

    const categorySlug = merchant.category_slug;
    const category = getCtx('category', categorySlug);
    if (!category) continue;

    // Resolve optional customer
    const customerId = trigger.customer_id;
    const customer = customerId ? getCtx('customer', customerId) : null;

    // Prevent duplicate conversation for same merchant+trigger
    const convId = `conv_${merchantId}_${trgId}`;
    if (conversations.has(convId)) continue;

    try {
      const composed = await compose(category, merchant, trigger, customer);

      // Mark suppression key
      if (composed.suppression_key) suppressionKeys.add(composed.suppression_key);

      // Initialize conversation state
      conversationManager.initConversation(convId, { category, merchant, trigger, customer }, composed.body);

      actions.push({
        conversation_id: convId,
        merchant_id: merchantId,
        customer_id: customerId || null,
        send_as: composed.send_as || 'vera',
        trigger_id: trgId,
        template_name: `vera_${trigger.kind}_v1`,
        template_params: [
          merchant.identity?.name || '',
          trigger.kind,
          composed.body?.slice(0, 80) || '',
        ],
        body: composed.body,
        cta: composed.cta,
        suppression_key: composed.suppression_key,
        rationale: composed.rationale,
      });
    } catch (err) {
      console.error(`[tick] Error composing for trigger ${trgId}:`, err.message);
      // Skip this trigger to not block the tick response
    }
  }

  return res.json({ actions });
});

// ---------------------------------------------------------------------------
// POST /v1/reply
// ---------------------------------------------------------------------------

app.post('/v1/reply', async (req, res) => {
  const {
    conversation_id,
    merchant_id,
    customer_id,
    from_role,
    message,
    received_at,
    turn_number,
  } = req.body || {};

  if (!conversation_id || !from_role || !message) {
    return res.status(400).json({ error: 'conversation_id, from_role, message are required' });
  }

  try {
    const result = await conversationManager.handleReply(
      conversation_id,
      from_role,
      message,
      turn_number || 1
    );

    return res.json(result);
  } catch (err) {
    console.error(`[reply] Error handling reply for ${conversation_id}:`, err.message);
    return res.json({
      action: 'send',
      body: 'Maafi chahungi — main dobara check karke aapko update karti hoon. (Sorry, processing error)',
      cta: 'none',
      rationale: `Error recovery: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// POST /v1/teardown (optional — wipe state at end of test)
// ---------------------------------------------------------------------------

app.post('/v1/teardown', (req, res) => {
  contexts.clear();
  conversations.clear();
  suppressionKeys.clear();
  console.log('[teardown] All state cleared.');
  return res.json({ cleared: true, ts: new Date().toISOString() });
});

// ---------------------------------------------------------------------------
// START SERVER
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`\n🤖 Vera AI Bot running on http://localhost:${PORT}`);
  console.log(`   Healthz:  http://localhost:${PORT}/v1/healthz`);
  console.log(`   Metadata: http://localhost:${PORT}/v1/metadata`);
  console.log(`\n   Make sure GEMINI_API_KEY is set in .env\n`);
});

export default app;
