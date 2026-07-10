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
  /\b(no\b|nahin|nahi|mat karo|band karo|stop\b|not interested|nahi chahiye)\b/i,
  /\b(busy hoon|baad mein|later|abhi nahi|not now|leave me alone|pest)\b/i,
  /\b(opt out|unsubscribe|block|remove me|mujhe mat bhejo)\b/i,
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
  const msg = message.trim();

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
  constructor(conversations) {
    // conversations is the shared Map from bot.js
    this.conversations = conversations;
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
  async handleReply(conversationId, fromRole, message, turnNumber) {
    const conv = this.conversations.get(conversationId);

    // Unknown conversation — create minimal state
    if (!conv) {
      return {
        action: 'send',
        body: 'Main samajh gayi. Aapke liye check karti hoon.',
        cta: 'none',
        rationale: 'Unknown conversation — generic acknowledgement',
      };
    }

    // Record the incoming message
    conv.history.push({ from: fromRole, body: message, ts: new Date().toISOString() });
    if (fromRole === 'merchant' || fromRole === 'customer') {
      conv.merchantMessages.push(message);
    }

    // --- Guard 1: Turn budget ---
    if (conv.turnCount >= 5) {
      conv.phase = 'ended';
      return {
        action: 'end',
        rationale: 'Reached 5-turn limit; gracefully exiting',
      };
    }

    // --- Guard 2: Conversation already ended ---
    if (conv.phase === 'ended') {
      return { action: 'end', rationale: 'Conversation already ended' };
    }

    // --- Guard 3: Auto-reply detection ---
    const autoReplyResult = detectAutoReply(message, conv.merchantMessages.slice(0, -1));
    if (autoReplyResult.isAutoReply) {
      if (shouldExitConversation(conv.merchantMessages)) {
        // Already tried once after auto-reply — exit
        conv.phase = 'ended';
        const exitMsg = conv.contexts?.merchant?.identity?.name
          ? `Koi baat nahi, samajh gayi. ${conv.contexts.merchant.identity.name} accha chal raha hai — best wishes! 🙂`
          : 'Koi baat nahi. Best wishes for your business! 🙂';
        conv.history.push({ from: 'vera', body: exitMsg, ts: new Date().toISOString() });
        return {
          action: 'end',
          rationale: `Auto-reply detected (confidence: ${autoReplyResult.confidence}) — graceful exit after retry`,
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
          rationale: `Auto-reply detected (confidence: ${autoReplyResult.confidence}) — attempting once more with clarification`,
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
