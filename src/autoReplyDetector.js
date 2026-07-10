/**
 * autoReplyDetector.js
 * Detects WhatsApp Business canned auto-replies from merchants.
 *
 * Production Vera burns 2-3 turns detecting auto-replies. We detect on turn 1.
 */

// Known auto-reply signature patterns (case-insensitive fragments)
const AUTO_REPLY_PATTERNS = [
  /thank\s*you\s*for\s*contact/i,
  /aapki\s*jaankari\s*ke\s*liye\s*bahut/i,
  /main\s*aapki\s*yeh\s*sabhi\s*baatein/i,
  /hamari\s*team\s*tak\s*pahuncha/i,
  /we\s*(will|shall)\s*(get\s*back|revert|respond)/i,
  /our\s*team\s*will\s*contact\s*you/i,
  /automated\s*(message|reply|response|assistant)/i,
  /i\s*am\s*(an?\s*)?(automated|auto)\s*(reply|message|bot|assistant)/i,
  /this\s*is\s*an?\s*automated/i,
  /currently\s*(unavailable|away|busy|out\s*of\s*(office|reach))/i,
  /business\s*hours.*reply\s*as\s*soon/i,
  /will\s*reply\s*(soon|shortly|at\s*the\s*earliest)/i,
  /dhanyavaad.*sampark/i,
  /shukriya.*sampark/i,
  /aapka\s*sandesh\s*mila/i,
  /namaste.*touch\s*mein\s*rahenge/i,
  /we\s*have\s*received\s*your\s*(message|query|inquiry)/i,
  /your\s*(message|query|inquiry)\s*has\s*been\s*received/i,
  /outside\s*(working|business|office)\s*hours/i,
  /ek\s*automated\s*assistant\s*hoon/i,
];

// Phrases that only appear in genuine merchant replies (negative signals)
const GENUINE_SIGNALS = [
  /\?/,          // questions = genuine
  /kab/i,        // "when" in Hindi
  /kitna/i,      // "how much"
  /kaise/i,      // "how"
  /chahiye/i,    // "I want/need"
  /bata/i,       // "tell me"
  /haan|yes|ok\b|okay|sure|chalega|theek/i,
  /nahin|nahi|no\b|nope|mat/i,
  /call\s*kar/i,
  /update\s*kar/i,
  /bhejo|send/i,
];

/**
 * Checks if a message is likely a WhatsApp Business auto-reply.
 * @param {string} message - The incoming message text
 * @param {string[]} history - Previous messages in the same conversation (from same sender)
 * @returns {{ isAutoReply: boolean, confidence: number, reason: string }}
 */
export function detectAutoReply(message, history = []) {
  if (!message || message.trim().length === 0) {
    return { isAutoReply: false, confidence: 0, reason: 'empty_message' };
  }

  const msg = message.trim();

  // --- Signal 1: Pattern match against known auto-reply phrases ---
  let patternMatch = false;
  let matchedPattern = null;
  for (const pattern of AUTO_REPLY_PATTERNS) {
    if (pattern.test(msg)) {
      patternMatch = true;
      matchedPattern = pattern.source;
      break;
    }
  }

  // --- Signal 2: Message verbatim repeat (same text sent 2+ times before) ---
  const repeatCount = history.filter(h => h.trim() === msg.trim()).length;
  const isVerbatimRepeat = repeatCount >= 1; // sent same text before

  // --- Signal 3: No genuine engagement signals ---
  let hasGenuineSignal = false;
  for (const signal of GENUINE_SIGNALS) {
    if (signal.test(msg)) {
      hasGenuineSignal = true;
      break;
    }
  }

  // --- Signal 4: Very long, formal, third-person language ---
  const isFormalLong = msg.length > 120 && /\bteam\b/i.test(msg) && /\bshukriya|thank\b/i.test(msg);

  // --- Confidence scoring ---
  let confidence = 0;
  if (patternMatch) confidence += 0.7;
  if (isVerbatimRepeat) confidence += 0.5;
  if (isFormalLong && !hasGenuineSignal) confidence += 0.3;
  if (hasGenuineSignal) confidence -= 0.4;

  confidence = Math.max(0, Math.min(1, confidence));
  const isAutoReply = confidence >= 0.5;

  return {
    isAutoReply,
    confidence: Math.round(confidence * 100) / 100,
    reason: isAutoReply
      ? `pattern=${matchedPattern || 'none'}, repeat=${repeatCount}, formal=${isFormalLong}`
      : `genuine_signal=${hasGenuineSignal}, confidence_below_threshold`,
  };
}

/**
 * Given conversation history, check if we've already tried once after detecting auto-reply.
 * If the last 2+ messages from the merchant are all auto-replies, return true (exit).
 */
export function shouldExitConversation(merchantMessages) {
  if (merchantMessages.length < 2) return false;
  const lastTwo = merchantMessages.slice(-2);
  return lastTwo.every(m => detectAutoReply(m, merchantMessages.slice(0, -2)).isAutoReply);
}
