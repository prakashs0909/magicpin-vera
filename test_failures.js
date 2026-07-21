import 'dotenv/config';

const BASE = 'http://localhost:8080';

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

async function main() {
  console.log('--- Teardown ---');
  await post('/v1/teardown', {});

  console.log('--- Loading Contexts ---');
  // Load Category dentists
  await post('/v1/context', {
    scope: 'category', context_id: 'dentists', version: 1,
    payload: {
      slug: 'dentists',
      voice: { tone: 'peer_clinical', code_mix: 'hindi_english_natural', vocab_taboo: ['guaranteed'] },
      offer_catalog: [{ id: 'den_001', title: 'Dental Cleaning @ ₹299', value: '299' }],
      peer_stats: { avg_rating: 4.4, avg_ctr: 0.030 },
      digest: [
        {
          id: 'd_2026W17_jida_fluoride', kind: 'research',
          title: '3-month fluoride recall cuts caries 38% better',
          source: 'JIDA Oct 2026, p.14', trial_n: 2100
        },
        {
          id: 'd_2026W17_dci_radiograph', kind: 'compliance',
          title: 'DCI revised radiograph dose limits',
          source: 'Dental Council of India circular 2026-11-04'
        }
      ],
    }
  });

  // Load Merchant
  await post('/v1/context', {
    scope: 'merchant', context_id: 'm_meera', version: 1,
    payload: {
      merchant_id: 'm_meera', category_slug: 'dentists',
      identity: { name: "Dr. Meera's Dental Clinic", city: 'Delhi', locality: 'Lajpat Nagar' },
      subscription: { status: 'active', plan: 'Pro', days_remaining: 82 },
      performance: { ctr: 0.021 },
      offers: [{ id: 'o_meera_001', title: 'Dental Cleaning @ ₹299', status: 'active' }],
      conversation_history: []
    }
  });

  // Load Customer
  await post('/v1/context', {
    scope: 'customer', context_id: 'c_priya', version: 1,
    payload: {
      customer_id: 'c_priya', merchant_id: 'm_meera',
      identity: { name: 'Priya', language_pref: 'hi-en mix' },
      relationship: { last_visit: '2026-05-12', services_received: ['cleaning'] },
      state: 'lapsed_soft',
      preferences: { preferred_slots: 'weekday_evening' }
    }
  });

  // Load Triggers
  await post('/v1/context', {
    scope: 'trigger', context_id: 'trg_radiograph', version: 1,
    payload: {
      id: 'trg_radiograph', scope: 'merchant', kind: 'regulation_change',
      merchant_id: 'm_meera',
      payload: { category: 'dentists', top_item_id: 'd_2026W17_dci_radiograph' }
    }
  });

  await post('/v1/context', {
    scope: 'trigger', context_id: 'trg_recall', version: 1,
    payload: {
      id: 'trg_recall', scope: 'customer', kind: 'recall_due',
      merchant_id: 'm_meera', customer_id: 'c_priya',
      payload: {
        service_due: '6_month_cleaning',
        available_slots: [
          { iso: '2026-11-05T18:00:00+05:30', label: 'Wed 5 Nov, 6pm' },
          { iso: '2026-11-06T17:00:00+05:30', label: 'Thu 6 Nov, 5pm' }
        ]
      }
    }
  });

  console.log('--- Triggering Tick ---');
  const tickRes = await post('/v1/tick', {
    now: new Date().toISOString(),
    available_triggers: ['trg_radiograph', 'trg_recall']
  });
  console.log('Tick response:', JSON.stringify(tickRes.body, null, 2));

  // Find conversation IDs
  const actions = tickRes.body.actions || [];
  const radiographAction = actions.find(a => a.trigger_id === 'trg_radiograph');
  const recallAction = actions.find(a => a.trigger_id === 'trg_recall');

  if (radiographAction) {
    console.log('\n--- Scenario 1: Merchant Technical Follow-up ---');
    const replyRes = await post('/v1/reply', {
      conversation_id: radiographAction.conversation_id,
      merchant_id: 'm_meera',
      customer_id: null,
      from_role: 'merchant',
      message: 'Got it doc - need help auditing my X-ray setup. We have an old D-speed film unit.',
      turn_number: 2
    });
    console.log('Merchant reply response:', JSON.stringify(replyRes.body, null, 2));
  } else {
    console.log('No radiograph action found in tick!');
  }

  if (recallAction) {
    console.log('\n--- Scenario 2: Customer Slot Pick ---');
    const replyRes = await post('/v1/reply', {
      conversation_id: recallAction.conversation_id,
      merchant_id: 'm_meera',
      customer_id: 'c_priya',
      from_role: 'customer',
      message: 'Yes please book me for Wed 5 Nov, 6pm.',
      turn_number: 2
    });
    console.log('Customer reply response:', JSON.stringify(replyRes.body, null, 2));
  } else {
    console.log('No recall action found in tick!');
  }
}

main().catch(console.error);
