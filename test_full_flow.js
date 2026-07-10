/**
 * test_full_flow.js
 * End-to-end test: push contexts → tick → reply chain
 * Tests WITHOUT needing the LLM (skips LLM calls gracefully if no API key)
 */

const BASE = 'http://localhost:8080';

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

function log(label, res) {
  const icon = res.status >= 200 && res.status < 300 ? '✅' : '❌';
  console.log(`\n${icon} ${label} [HTTP ${res.status}]`);
  console.log(JSON.stringify(res.body, null, 2));
}

async function main() {
  console.log('\n════════════════════════════════════');
  console.log('  Vera Bot — Full Flow Test');
  console.log('════════════════════════════════════\n');

  // ── Teardown first (clean slate) ──
  const td = await post('/v1/teardown', {});
  log('POST /v1/teardown (clean slate)', td);

  // ── Phase 1: Healthz + Metadata ──
  log('GET  /v1/healthz', await get('/v1/healthz'));
  log('GET  /v1/metadata', await get('/v1/metadata'));

  // ── Phase 2: Push contexts ──

  // Category
  const cat = await post('/v1/context', {
    scope: 'category', context_id: 'dentists', version: 1,
    delivered_at: '2026-04-26T09:45:00Z',
    payload: {
      slug: 'dentists',
      voice: { tone: 'peer_clinical', code_mix: 'hindi_english_natural', vocab_taboo: ['guaranteed', '100% safe'] },
      offer_catalog: [
        { id: 'den_001', title: 'Dental Cleaning @ \u20b9299', value: '299', audience: 'new_user' },
        { id: 'den_003', title: 'Teeth Whitening @ \u20b91,499', value: '1499', audience: 'new_user' },
      ],
      peer_stats: { avg_rating: 4.4, avg_ctr: 0.030, avg_views_30d: 1820, avg_calls_30d: 12 },
      digest: [{
        id: 'd_2026W17_jida_fluoride', kind: 'research',
        title: '3-month fluoride varnish recall outperforms 6-month for high-risk adult caries',
        source: 'JIDA Oct 2026, p.14', trial_n: 2100, patient_segment: 'high_risk_adults',
        summary: '38% lower caries recurrence with 3-month vs 6-month recall in adults with active decay history.',
        actionable: 'Reassess recall interval for adults flagged high-risk in your charting',
      }, {
        id: 'd_2026W17_dci_radiograph', kind: 'compliance',
        title: 'DCI revised radiograph dose limits effective 2026-12-15',
        source: 'Dental Council of India circular 2026-11-04',
        summary: 'Maximum dose per IOPA drops from 1.5 mSv to 1.0 mSv.',
        actionable: 'Audit your X-ray setup before Dec 15',
      }],
      patient_content_library: [],
      seasonal_beats: [{ month_range: 'Nov-Feb', note: 'exam-stress bruxism spike' }],
      trend_signals: [{ query: 'clear aligners delhi', delta_yoy: 0.62, segment_age: '28-45' }],
    },
  });
  log('POST /v1/context — category:dentists v1', cat);

  // Merchant
  const merchant = await post('/v1/context', {
    scope: 'merchant', context_id: 'm_001_drmeera_dentist_delhi', version: 1,
    delivered_at: '2026-04-26T09:46:00Z',
    payload: {
      merchant_id: 'm_001_drmeera_dentist_delhi', category_slug: 'dentists',
      identity: { name: "Dr. Meera's Dental Clinic", city: 'Delhi', locality: 'Lajpat Nagar',
                  place_id: 'ChIJ_LAJPATNAGAR_001', verified: true, languages: ['en', 'hi'], owner_first_name: 'Meera' },
      subscription: { status: 'active', plan: 'Pro', days_remaining: 82 },
      performance: { window_days: 30, views: 2410, calls: 18, directions: 45, ctr: 0.021, leads: 9,
                     delta_7d: { views_pct: 0.18, calls_pct: -0.05 } },
      offers: [{ id: 'o_meera_001', title: 'Dental Cleaning @ \u20b9299', status: 'active' }],
      conversation_history: [],
      customer_aggregate: { total_unique_ytd: 540, lapsed_180d_plus: 78, retention_6mo_pct: 0.38, high_risk_adult_count: 124 },
      signals: ['stale_posts:22d', 'ctr_below_peer_median', 'high_risk_adult_cohort'],
      review_themes: [
        { theme: 'wait_time', sentiment: 'neg', occurrences_30d: 3, common_quote: 'had to wait 30 min on Sunday' },
        { theme: 'doctor_manner', sentiment: 'pos', occurrences_30d: 5 },
      ],
    },
  });
  log('POST /v1/context — merchant:m_001 v1', merchant);

  // Customer
  const customer = await post('/v1/context', {
    scope: 'customer', context_id: 'c_001_priya_for_m001', version: 1,
    delivered_at: '2026-04-26T09:47:00Z',
    payload: {
      customer_id: 'c_001_priya_for_m001', merchant_id: 'm_001_drmeera_dentist_delhi',
      identity: { name: 'Priya', phone_redacted: '<phone>', language_pref: 'hi-en mix', age_band: '25-35' },
      relationship: { first_visit: '2025-11-04', last_visit: '2026-05-12', visits_total: 4,
                      services_received: ['cleaning', 'cleaning', 'whitening', 'cleaning'], lifetime_value: 1696 },
      state: 'lapsed_soft',
      preferences: { preferred_slots: 'weekday_evening', channel: 'whatsapp', reminder_opt_in: true },
      consent: { opted_in_at: '2025-11-04', scope: ['recall_reminders', 'appointment_reminders'] },
    },
  });
  log('POST /v1/context — customer:c_001_priya v1', customer);

  // Trigger: research_digest
  const trg1 = await post('/v1/context', {
    scope: 'trigger', context_id: 'trg_001_research_digest_dentists', version: 1,
    delivered_at: '2026-04-26T10:00:00Z',
    payload: {
      id: 'trg_001_research_digest_dentists', scope: 'merchant', kind: 'research_digest', source: 'external',
      merchant_id: 'm_001_drmeera_dentist_delhi', customer_id: null,
      payload: { category: 'dentists', top_item_id: 'd_2026W17_jida_fluoride' },
      urgency: 2, suppression_key: 'research:dentists:2026-W17', expires_at: '2026-05-03T00:00:00Z',
    },
  });
  log('POST /v1/context — trigger:research_digest v1', trg1);

  // Trigger: recall_due (customer-scoped)
  const trg2 = await post('/v1/context', {
    scope: 'trigger', context_id: 'trg_003_recall_due_priya', version: 1,
    delivered_at: '2026-04-26T10:05:00Z',
    payload: {
      id: 'trg_003_recall_due_priya', scope: 'customer', kind: 'recall_due', source: 'internal',
      merchant_id: 'm_001_drmeera_dentist_delhi', customer_id: 'c_001_priya_for_m001',
      payload: {
        service_due: '6_month_cleaning', last_service_date: '2026-05-12', due_date: '2026-11-12',
        available_slots: [
          { iso: '2026-11-05T18:00:00+05:30', label: 'Wed 5 Nov, 6pm' },
          { iso: '2026-11-06T17:00:00+05:30', label: 'Thu 6 Nov, 5pm' },
        ],
      },
      urgency: 3, suppression_key: 'recall:c_001_priya_for_m001:6mo', expires_at: '2026-11-30T00:00:00Z',
    },
  });
  log('POST /v1/context — trigger:recall_due v1', trg2);

  // Trigger: perf_dip
  const trg3 = await post('/v1/context', {
    scope: 'trigger', context_id: 'trg_004_perf_dip_meera', version: 1,
    delivered_at: '2026-04-26T10:10:00Z',
    payload: {
      id: 'trg_004_perf_dip_meera', scope: 'merchant', kind: 'perf_dip', source: 'internal',
      merchant_id: 'm_001_drmeera_dentist_delhi', customer_id: null,
      payload: { metric: 'calls', delta_pct: -0.50, window: '7d', vs_baseline: 12 },
      urgency: 4, suppression_key: 'perf_dip:m_001:calls:2026-W17', expires_at: '2026-05-10T00:00:00Z',
    },
  });
  log('POST /v1/context — trigger:perf_dip v1', trg3);

  // Trigger: regulation_change
  const trg4 = await post('/v1/context', {
    scope: 'trigger', context_id: 'trg_002_compliance_dci', version: 1,
    delivered_at: '2026-04-26T10:12:00Z',
    payload: {
      id: 'trg_002_compliance_dci', scope: 'merchant', kind: 'regulation_change', source: 'external',
      merchant_id: 'm_001_drmeera_dentist_delhi', customer_id: null,
      payload: { category: 'dentists', top_item_id: 'd_2026W17_dci_radiograph', deadline_iso: '2026-12-15' },
      urgency: 4, suppression_key: 'compliance:dci_radiograph:2026', expires_at: '2026-12-15T00:00:00Z',
    },
  });
  log('POST /v1/context — trigger:regulation_change v1', trg4);

  // ── Healthz should now show counts ──
  log('GET  /v1/healthz (after pushes)', await get('/v1/healthz'));

  // ── Idempotency & error cases ──
  const stale = await post('/v1/context', { scope: 'category', context_id: 'dentists', version: 0, delivered_at: new Date().toISOString(), payload: {} });
  log('POST /v1/context — stale version (expect 409)', stale);

  const bad = await post('/v1/context', { scope: 'badscope', context_id: 'x', version: 1, delivered_at: new Date().toISOString(), payload: {} });
  log('POST /v1/context — invalid scope (expect 400)', bad);

  // ── Phase 3: Tick (requires GEMINI_API_KEY for LLM compose) ──
  console.log('\n────────────────────────────────────');
  console.log('  Phase 3: Tick (LLM composition)');
  if (!process.env.GEMINI_API_KEY) {
    console.log('  ⚠️  GEMINI_API_KEY not set — tick will return empty actions (no LLM call)');
  }
  console.log('────────────────────────────────────');

  const tick = await post('/v1/tick', {
    now: '2026-04-26T10:30:00Z',
    available_triggers: ['trg_001_research_digest_dentists', 'trg_003_recall_due_priya', 'trg_004_perf_dip_meera', 'trg_002_compliance_dci'],
  });
  log('POST /v1/tick — 4 triggers (LLM compose)', tick);

  // ── Phase 4: Reply ──
  console.log('\n────────────────────────────────────');
  console.log('  Phase 4: Multi-turn Replies');
  console.log('────────────────────────────────────');

  // Get conversation_id from tick if it returned any
  const firstConvId = tick.body?.actions?.[0]?.conversation_id;
  const convId = firstConvId || 'conv_m_001_drmeera_dentist_delhi_trg_001_research_digest_dentists';

  console.log(`\n  Using conversation_id: ${convId}`);

  // Test: auto-reply detection
  const autoReply = await post('/v1/reply', {
    conversation_id: convId,
    merchant_id: 'm_001_drmeera_dentist_delhi',
    customer_id: null, from_role: 'merchant',
    message: 'Aapki jaankari ke liye bahut-bahut shukriya. Main aapki yeh sabhi baatein aur sujhaav hamari team tak pahuncha deti hoon.',
    received_at: '2026-04-26T10:46:00Z', turn_number: 2,
  });
  log('POST /v1/reply — Auto-reply (should retry once)', autoReply);

  // Test: merchant accepts (different conv)
  const yesConvId = `conv_accept_test_${Date.now()}`;
  const yesReply = await post('/v1/reply', {
    conversation_id: yesConvId,
    merchant_id: 'm_001_drmeera_dentist_delhi',
    customer_id: null, from_role: 'merchant',
    message: 'Yes please, kar do! Send the abstract.',
    received_at: '2026-04-26T10:47:00Z', turn_number: 2,
  });
  log('POST /v1/reply — Merchant accepts (action=send, action mode)', yesReply);

  // Test: merchant rejects
  const noReply = await post('/v1/reply', {
    conversation_id: `conv_reject_test_${Date.now()}`,
    merchant_id: 'm_001_drmeera_dentist_delhi',
    customer_id: null, from_role: 'merchant',
    message: 'Nahin chahiye, abhi busy hoon. Band karo.',
    received_at: '2026-04-26T10:48:00Z', turn_number: 2,
  });
  log('POST /v1/reply — Merchant rejects (action=end)', noReply);

  // ── Phase 5: Teardown ──
  const teardown = await post('/v1/teardown', {});
  log('POST /v1/teardown', teardown);

  log('GET  /v1/healthz (after teardown, should be zeros)', await get('/v1/healthz'));

  console.log('\n════════════════════════════════════');
  console.log('  Full flow test complete!');
  console.log('  Add GEMINI_API_KEY to .env for LLM composition.');
  console.log('════════════════════════════════════\n');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
