/**
 * conversationHandler.js
 * Multi-turn conversation state management for Vera.
 *
 * Handles:
 * - Auto-reply detection (Pattern B from brief)
 * - Intent transition: "yes" → action mode (Pattern D failure prevention)
 * - Graceful exit on disinterest
 * - Turn budget enforcement (max 5 turns)
 */

import { detectAutoReply, shouldExitConversation } from './autoReplyDetector.js';
import { composeReply } from './composer.js';

// ---------------------------------------------------------------------------
// INTENT DETECTION
// ---------------------------------------------------------------------------

// Acceptance / action-ready signals
const ACCEPTANCE_PATTERNS = [
  /\b(yes|ya|haan|chalega|theek hai|ok\b|okay|sure|bilkul|zaroor|perfect)\b/i,
  /\b(go ahead|kar do|send kar|bhejo|start kar|proceed|let'?s do it|aage badho)\b/i,
  /\b(please (do it|update|send|post)|kar dijiye|update kar|draft kar)\b/i,
  /\b(join karna hai|judrna hai|join karo|sign me up|enroll)\b/i,
];

// Rejection / exit signals
const REJECTION_PATTERNS = [
  /\b(no\b|nahin|nahi|mat karo|band karo|stop\b|not interested|nahi chahiye|opt out|unsubscribe|block|remove me|mujhe mat bhejo|disinterest|spam|abuse)\b/i,
  /\b(busy hoon|baad mein|later|abhi nahi|not now|leave me alone|pest|go away|don't message|dont message)\b/i,
];

// Question patterns (merchant wants more info)
const QUESTION_PATTERNS = [/\?/, /\b(kya|kaise|kyun|kitna|kab|kaun|tell me|batao|explain)\b/i];

/**
 * Classify merchant intent from their message.
 * @param {string} message
 * @returns {'accept' | 'reject' | 'question' | 'neutral'}
 */
function classifyIntent(message) {
  if (!message) return 'neutral';
  const msg = message.trim().toLowerCase();

  // Direct stop/unsubscribe check
  if (msg === 'stop' || msg === 'unsubscribe' || msg === 'block') return 'reject';

  for (const pattern of ACCEPTANCE_PATTERNS) {
    if (pattern.test(msg)) return 'accept';
  }
  for (const pattern of REJECTION_PATTERNS) {
    if (pattern.test(msg)) return 'reject';
  }
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(msg)) return 'question';
  }
  return 'neutral';
}

// ---------------------------------------------------------------------------
// CONVERSATION STATE MANAGER
// ---------------------------------------------------------------------------

/**
 * Manages in-memory state for each active conversation.
 * Each conversation has:
 * - history: [ { from: 'vera'|'merchant', body, ts } ]
 * - merchantMessages: just the merchant's messages (for auto-reply detection)
 * - turnCount: how many bot turns taken
 * - phase: 'pitching' | 'acting' | 'ended'
 * - contexts: { category, merchant, trigger, customer }
 */
export class ConversationManager {
  constructor(conversations, contexts) {
    // conversations is the shared Map from bot.js
    this.conversations = conversations;
    // contexts is the shared Map from bot.js
    this.contexts = contexts;
  }

  getCtx(scope, contextId) {
    if (!this.contexts || !contextId) return null;
    return this.contexts.get(`${scope}::${contextId}`)?.payload || null;
  }

  /**
   * Initialize a new conversation.
   */
  initConversation(conversationId, contexts, botMessage) {
    this.conversations.set(conversationId, {
      history: [{ from: 'vera', body: botMessage, ts: new Date().toISOString() }],
      merchantMessages: [],
      turnCount: 1,
      phase: 'pitching',
      contexts,
    });
  }

  /**
   * Process a merchant (or customer) reply and produce the bot's next action.
   *
   * @param {string} conversationId
   * @param {string} fromRole  - 'merchant' | 'customer'
   * @param {string} message
   * @param {number} turnNumber
   * @returns {Promise<{ action: string, body?: string, cta?: string, wait_seconds?: number, rationale: string }>}
   */
  async handleReply(conversationId, fromRole, message, turnNumber, merchantId = null, customerId = null) {
    let conv = this.conversations.get(conversationId);

    // Reconstruct conversation from contexts if not found in memory
    if (!conv) {
      const merchant = this.getCtx('merchant', merchantId);
      if (!merchant) {
        return {
          action: 'send',
          body: 'Main samajh gayi. Aapke liye check karti hoon.',
          cta: 'none',
          rationale: 'Unknown conversation and merchant context not found',
        };
      }
      const category = this.getCtx('category', merchant.category_slug);
      const customer = customerId ? this.getCtx('customer', customerId) : null;

      // Scan for a trigger context matching this merchant (and customer if applicable)
      let trigger = null;
      let triggerId = null;
      if (conversationId.startsWith(`conv_${merchantId}_`)) {
        triggerId = conversationId.substring(`conv_${merchantId}_`.length);
      }
      if (triggerId) {
        trigger = this.getCtx('trigger', triggerId);
      }

      if (!trigger && this.contexts) {
        for (const [key, ctx] of this.contexts.entries()) {
          if (key.startsWith('trigger::')) {
            const t = ctx.payload;
            if (t.merchant_id === merchantId) {
              if (!customerId || t.customer_id === customerId) {
                trigger = t;
                break;
              }
            }
          }
        }
      }

      conv = {
        history: [],
        merchantMessages: [],
        turnCount: turnNumber - 1,
        phase: 'pitching',
        contexts: { category, merchant, trigger, customer }
      };

      // Reconstruct history if merchant has conversation_history
      if (Array.isArray(merchant.conversation_history) && merchant.conversation_history.length > 0) {
        for (const h of merchant.conversation_history) {
          conv.history.push({
            from: h.from === 'vera' ? 'vera' : 'merchant',
            body: h.body,
            ts: h.ts || new Date().toISOString()
          });
          if (h.from !== 'vera') {
            conv.merchantMessages.push(h.body);
          }
        }
      }

      this.conversations.set(conversationId, conv);
    }

    // Record the incoming message
    conv.history.push({ from: fromRole, body: message, ts: new Date().toISOString() });
    if (fromRole === 'merchant' || fromRole === 'customer') {
      conv.merchantMessages.push(message);
    }

    // --- Guard 1: Turn budget ---
    if (conv.turnCount >= 5 || turnNumber >= 5) {
      conv.phase = 'ended';
      return {
        action: 'end',
        rationale: `Reached turn limit (turnCount: ${conv.turnCount}, turnNumber: ${turnNumber}); gracefully exiting`,
      };
    }

    // --- Guard 2: Conversation already ended ---
    if (conv.phase === 'ended') {
      return { action: 'end', rationale: 'Conversation already ended' };
    }

    // --- Customer reply path ---
    if (fromRole === 'customer') {
      conv.turnCount++;

      // Slot selection detection
      let selectedSlot = null;
      const slots = conv.contexts?.trigger?.payload?.available_slots;
      if (Array.isArray(slots) && slots.length > 0) {
        const msgLower = message.trim().toLowerCase();

        // Match option index/number first
        if (/^\s*1\s*$/.test(msgLower) || /\b(first|option 1|slot 1|1st|one)\b/i.test(msgLower)) {
          selectedSlot = slots[0];
        } else if (/^\s*2\s*$/.test(msgLower) || /\b(second|option 2|slot 2|2nd|two)\b/i.test(msgLower)) {
          selectedSlot = slots[1];
        } else if (/^\s*3\s*$/.test(msgLower) || /\b(third|option 3|slot 3|3rd|three)\b/i.test(msgLower)) {
          selectedSlot = slots[2];
        }

        // Match keywords/labels if index did not match
        if (!selectedSlot) {
          for (const slot of slots) {
            if (slot.label) {
              const labelLower = slot.label.toLowerCase();
              const terms = labelLower.split(/[\s,.-]+/).filter(t => t.length > 1);
              const hasTime = labelLower.match(/\b\d+(?:am|pm)\b/i);
              const hasDate = labelLower.match(/\b\d+\s+[a-z]{3}\b/i);

              let matchesAll = false;
              if (hasTime && hasDate) {
                const timeStr = hasTime[0].toLowerCase();
                const dateStr = hasDate[0].toLowerCase();
                if (msgLower.includes(timeStr) && msgLower.includes(dateStr)) {
                  matchesAll = true;
                }
              }
              if (!matchesAll && terms.length > 0) {
                let matchCount = 0;
                for (const term of terms) {
                  if (msgLower.includes(term)) {
                    matchCount++;
                  }
                }
                if (matchCount >= 2) {
                  matchesAll = true;
                }
              }

              if (matchesAll) {
                selectedSlot = slot;
                break;
              }
            }
          }
        }
      }

      const replyResult = await composeReply(
        {
          ...conv.contexts,
          history: conv.history,
          isCustomerFacing: true,
          selectedSlot,
        },
        message
      );

      if (replyResult.action === 'end') {
        conv.phase = 'ended';
        return {
          action: 'end',
          rationale: replyResult.rationale || 'Customer conversation concluded',
        };
      }

      const body = replyResult.body || 'Got it!';
      conv.history.push({ from: 'vera', body, ts: new Date().toISOString() });

      return {
        action: 'send',
        body,
        cta: replyResult.cta || 'none',
        rationale: replyResult.rationale || 'Replied to customer',
      };
    }

    // --- Merchant reply path ---

    // --- Guard 3: Auto-reply detection ---
    const autoReplyResult = detectAutoReply(message, conv.merchantMessages.slice(0, -1));
    if (autoReplyResult.isAutoReply) {
      if (turnNumber >= 3 || shouldExitConversation(conv.merchantMessages)) {
        // Already tried once after auto-reply — exit
        conv.phase = 'ended';
        const exitMsg = conv.contexts?.merchant?.identity?.name
          ? `Koi baat nahi, samajh gayi. ${conv.contexts.merchant.identity.name} accha chal raha hai — best wishes! 🙂`
          : 'Koi baat nahi. Best wishes for your business! 🙂';
        conv.history.push({ from: 'vera', body: exitMsg, ts: new Date().toISOString() });
        return {
          action: 'end',
          rationale: `Auto-reply detected (confidence: ${autoReplyResult.confidence}, turn: ${turnNumber}) — graceful exit`,
        };
      } else {
        // First auto-reply detected — try once more with a clarifying message
        conv.turnCount++;
        const retryMsg = this._buildAutoReplyRetry(conv);
        conv.history.push({ from: 'vera', body: retryMsg, ts: new Date().toISOString() });
        return {
          action: 'send',
          body: retryMsg,
          cta: 'open_ended',
          rationale: `Auto-reply detected (confidence: ${autoReplyResult.confidence}, turn: ${turnNumber}) — attempting once more with clarification`,
        };
      }
    }

    // --- Guard 4: Intent classification ---
    const intent = classifyIntent(message);

    if (intent === 'reject') {
      conv.phase = 'ended';
      const exitMsg = 'Samajh gayi, bilkul theek hai. Kabhi zaroorat ho toh main hoon. Best wishes! 🙏';
      conv.history.push({ from: 'vera', body: exitMsg, ts: new Date().toISOString() });
      return {
        action: 'end',
        rationale: 'Merchant expressed disinterest — graceful exit',
      };
    }

    if (intent === 'accept' && conv.phase === 'pitching') {
      // CRITICAL: switch to action mode immediately (Pattern D failure prevention)
      conv.phase = 'acting';
    }

    // --- Normal LLM reply composition ---
    conv.turnCount++;
    const replyResult = await composeReply(
      {
        ...conv.contexts,
        history: conv.history,
        isCustomerFacing: false,
      },
      message
    );

    // Handle wait action from LLM
    if (replyResult.action === 'wait') {
      return {
        action: 'wait',
        wait_seconds: replyResult.wait_seconds || 1800,
        rationale: replyResult.rationale || 'Merchant requested time',
      };
    }

    // Handle end action from LLM
    if (replyResult.action === 'end') {
      conv.phase = 'ended';
      return {
        action: 'end',
        rationale: replyResult.rationale || 'Conversation concluded',
      };
    }

    // Send action (default)
    const body = replyResult.body || 'Main aapke liye yeh arrange karti hoon!';
    conv.history.push({ from: 'vera', body, ts: new Date().toISOString() });

    return {
      action: 'send',
      body,
      cta: replyResult.cta || 'none',
      rationale: replyResult.rationale || 'Continued conversation',
    };
  }

  /**
   * Build a re-engagement message after detecting auto-reply.
   */
  _buildAutoReplyRetry(conv) {
    const name = conv.contexts?.merchant?.identity?.name;
    const locality = conv.contexts?.merchant?.identity?.locality;
    if (name) {
      return `Samajh gayi — team ko message pahunch gaya. ${name} ke owner/manager se directly connect karna chahungi. ${locality ? locality + ' mein aapka business accha hai' : 'Aapka business accha hai'} — kya 2 minute ho sakte hain? Chalega?`;
    }
    return 'Team ka message mila. Main directly owner/manager se baat karna chahungi — kya aap available hain? 2 minute ka kaam hai.';
  }

  /**
   * Get conversation history for a given conversation ID.
   */
  getHistory(conversationId) {
    return this.conversations.get(conversationId)?.history || [];
  }
}
