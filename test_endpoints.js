/**
 * test_endpoints.js
 * Quick smoke test of all 5 bot endpoints.
 * Run: node test_endpoints.js
 */

const BASE = 'http://localhost:8080';

async function req(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${BASE}${path}`, opts);
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

function ok(label, condition, detail = '') {
  const icon = condition ? '✅' : '❌';
  console.log(`  ${icon} ${label}${detail ? ' — ' + detail : ''}`);
  return condition;
}

async function main() {
  console.log('\n=== Vera Bot Smoke Test ===\n');
  let passes = 0, total = 0;

  // 1. GET /v1/healthz
  console.log('1. GET /v1/healthz');
  const h = await req('GET', '/v1/healthz');
  total++;
  if (ok('Status 200', h.status === 200) &&
      ok('status=ok', h.body.status === 'ok') &&
      ok('uptime_seconds present', typeof h.body.uptime_seconds === 'number') &&
      ok('contexts_loaded present', h.body.contexts_loaded !== undefined)) passes++;
  console.log(`   Response: ${JSON.stringify(h.body)}\n`);

  // 2. GET /v1/metadata
  console.log('2. GET /v1/metadata');
  const m = await req('GET', '/v1/metadata');
  total++;
  if (ok('Status 200', m.status === 200) &&
      ok('team_name present', !!m.body.team_name) &&
      ok('model present', !!m.body.model)) passes++;
  console.log(`   Response: ${JSON.stringify(m.body)}\n`);

  // 3. POST /v1/context — push a category
  console.log('3. POST /v1/context (category push)');
  const catPayload = {
    scope: 'category', context_id: 'dentists', version: 1,
    delivered_at: new Date().toISOString(),
    payload: {
      slug: 'dentists',
      voice: { tone: 'peer_clinical', vocab_taboo: ['guaranteed'] },
      offer_catalog: [{ id: 'den_001', title: 'Dental Cleaning @ ₹299', value: '299' }],
      peer_stats: { avg_rating: 4.4, avg_ctr: 0.030 },
      digest: [{ id: 'd_001', kind: 'research', title: '3-month fluoride recall cuts caries 38% better', source: 'JIDA Oct 2026, p.14', trial_n: 2100 }],
      seasonal_beats: [], trend_signals: [], patient_content_library: [],
    }
  };
  const ctx = await req('POST', '/v1/context', catPayload);
  total++;
  if (ok('Status 200', ctx.status === 200) &&
      ok('accepted=true', ctx.body.accepted === true) &&
      ok('ack_id present', !!ctx.body.ack_id)) passes++;
  console.log(`   Response: ${JSON.stringify(ctx.body)}\n`);

  // 3b. Idempotency: same version = no-op
  console.log('3b. POST /v1/context (duplicate same version — expect no-op 200)');
  const ctx2 = await req('POST', '/v1/context', catPayload);
  total++;
  if (ok('Status 200', ctx2.status === 200) &&
      ok('accepted=true (idempotent)', ctx2.body.accepted === true)) passes++;
  console.log(`   Response: ${JSON.stringify(ctx2.body)}\n`);

  // 3c. Stale version
  console.log('3c. POST /v1/context (stale version v=0 — expect 409)');
  const ctx3 = await req('POST', '/v1/context', { ...catPayload, version: 0 });
  total++;
  if (ok('Status 409', ctx3.status === 409) &&
      ok('reason=stale_version', ctx3.body.reason === 'stale_version')) passes++;
  console.log(`   Response: ${JSON.stringify(ctx3.body)}\n`);

  // 3d. Invalid scope
  console.log('3d. POST /v1/context (invalid scope — expect 400)');
  const ctx4 = await req('POST', '/v1/context', { ...catPayload, scope: 'invalid_scope', version: 2 });
  total++;
  if (ok('Status 400', ctx4.status === 400) &&
      ok('reason=invalid_scope', ctx4.body.reason === 'invalid_scope')) passes++;
  console.log(`   Response: ${JSON.stringify(ctx4.body)}\n`);

  // 4. POST /v1/tick — no triggers yet, should return empty actions
  console.log('4. POST /v1/tick (no triggers available)');
  const tick = await req('POST', '/v1/tick', { now: new Date().toISOString(), available_triggers: [] });
  total++;
  if (ok('Status 200', tick.status === 200) &&
      ok('actions is array', Array.isArray(tick.body.actions)) &&
      ok('actions empty (no triggers)', tick.body.actions.length === 0)) passes++;
  console.log(`   Response: ${JSON.stringify(tick.body)}\n`);

  // 5. POST /v1/reply — unknown conversation
  console.log('5. POST /v1/reply (unknown conversation — graceful handling)');
  const reply = await req('POST', '/v1/reply', {
    conversation_id: 'conv_test_unknown',
    from_role: 'merchant',
    message: 'Yes, please update my profile',
    received_at: new Date().toISOString(),
    turn_number: 1,
  });
  total++;
  if (ok('Status 200', reply.status === 200) &&
      ok('action present', !!reply.body.action)) passes++;
  console.log(`   Response: ${JSON.stringify(reply.body)}\n`);

  // 6. POST /v1/teardown
  console.log('6. POST /v1/teardown');
  const td = await req('POST', '/v1/teardown');
  total++;
  if (ok('Status 200', td.status === 200) &&
      ok('cleared=true', td.body.cleared === true)) passes++;
  console.log(`   Response: ${JSON.stringify(td.body)}\n`);

  // Summary
  console.log('='.repeat(40));
  console.log(`  Result: ${passes}/${total} tests passed`);
  if (passes === total) {
    console.log('  🎉 All endpoints working correctly!');
  } else {
    console.log('  ⚠️  Some tests failed — check output above');
  }
  console.log('');
}

main().catch(e => {
  console.error('Test error:', e.message);
  console.error('Is the server running? npm start');
  process.exit(1);
});
