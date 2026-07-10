#!/usr/bin/env node
/**
 * generate_dataset.js
 * Expands seed JSON files into the full challenge dataset.
 * Node.js port of generate_dataset.py — identical deterministic output.
 *
 * Usage:
 *   node generate_dataset.js --seed-dir ../magicpin-ai-challenge/dataset --out ./expanded
 */

import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';

// ---------------------------------------------------------------------------
// CONFIGURATION (mirrors Python script constants)
// ---------------------------------------------------------------------------

const SEED = 20260426;

const LOCALITIES = {
  Delhi: ['Lajpat Nagar','Saket','Karol Bagh','Pitampura','Dwarka','Rohini','Greater Kailash','Vasant Kunj','Connaught Place','Hauz Khas'],
  Mumbai: ['Andheri West','Bandra','Borivali','Powai','Lower Parel','Goregaon','Thane','Vile Parle','Juhu','Worli'],
  Bangalore: ['HSR Layout','Indiranagar','Whitefield','Koramangala','JP Nagar','Marathahalli','Bellandur','Jayanagar','BTM Layout','Sarjapur'],
  Hyderabad: ['Kapra','Kondapur','Madhapur','Banjara Hills','Jubilee Hills','Kukatpally','Gachibowli','Begumpet','Secunderabad','LB Nagar'],
  Chennai: ['Mylapore','Adyar','Velachery','T Nagar','Anna Nagar','Tambaram','OMR','Nungambakkam','Porur','Besant Nagar'],
  Pune: ['Aundh','Baner','Hadapsar','Kothrud','Wakad','Hinjewadi','Viman Nagar','Kharadi','Pimpri','Magarpatta'],
  Chandigarh: ['Sector 17','Sector 22','Sector 35','Mohali','Panchkula','Sector 9','Sector 11','Manimajra','Sector 8','Sector 26'],
  Jaipur: ['Malviya Nagar','Vaishali Nagar','Mansarovar','Tonk Road','C-Scheme','Raja Park','Civil Lines','Jhotwara','Bani Park','Sodala'],
  Lucknow: ['Gomti Nagar','Hazratganj','Indira Nagar','Aliganj','Aminabad','Vibhuti Khand','Mahanagar','Aashiana','Alambagh','Janakipuram'],
  Ahmedabad: ['Satellite','Bodakdev','Vastrapur','Maninagar','Naranpura','Bopal','SG Highway','Navrangpura','Thaltej','Chandkheda'],
};

const NAME_BANKS = {
  dentists: [
    ['Dr. Asha','Asha Dental Care'],['Dr. Vikram','Smile Crafters'],['Dr. Neha','Pearl Dental Studio'],
    ['Dr. Rajan','City Dental Clinic'],['Dr. Priya','Family Dental Centre'],['Dr. Sameer','Bright Smile Dental'],
    ['Dr. Tara','Crown Dental'],['Dr. Karthik','Apex Dental Care'],
  ],
  salons: [
    ['Renu','Beauty Lounge by Renu'],['Karim',"Karim's Salon"],['Anita',"Anita's Beauty Studio"],
    ['Salim','Studio Cuts'],['Manish','Aesthetic Hair Studio'],['Geeta','Glow Up Salon'],
    ['Paras','Paras Hair & Beauty'],['Sushma','The Beauty Bar'],
  ],
  restaurants: [
    ['Suresh','Madras Express'],['Anand','Chai Point Cafe'],['Karim','Kabab Junction'],
    ['Sandeep','Tandoor Treats'],['Ravi','Veg Bowl'],['Imran','Biryani House'],
    ['Mukesh','Pizza Spot'],['Lalit','Family Diner'],
  ],
  gyms: [
    ['Karan','Iron Forge Fitness'],['Sneha','Pulse Studio'],['Akash','Fit Republic'],
    ['Roshni','Active Life Gym'],['Vivek','Strength Co.'],['Manisha','Vyayam Yoga'],
    ['Deepak','Body Mechanics'],['Pooja','Bend & Burn'],
  ],
  pharmacies: [
    ['Anil','Healthwell Pharmacy'],['Rajesh','MedPlus Express'],['Sunita','Reliable Medicos'],
    ['Vinod','Family Health Pharmacy'],['Bharti','Wellness Cart'],['Sanjay','TrueCare Medicos'],
    ['Mohit','QuickRx Pharmacy'],['Komal','Daily Care Medicos'],
  ],
};

// ---------------------------------------------------------------------------
// SEEDED PRNG (Linear Congruential Generator — matches Python random.Random)
// We implement a simple LCG so output is deterministic.
// ---------------------------------------------------------------------------

class SeededRandom {
  constructor(seed) {
    // Use a simple xorshift for deterministic results
    this.state = BigInt(seed);
    this._M = BigInt(2 ** 31 - 1);
    this._A = BigInt(1103515245);
    this._C = BigInt(12345);
  }

  _next() {
    this.state = (this._A * this.state + this._C) % this._M;
    return Number(this.state) / Number(this._M);
  }

  random() { return this._next(); }

  randint(lo, hi) {
    return lo + Math.floor(this._next() * (hi - lo + 1));
  }

  choice(arr) {
    return arr[Math.floor(this._next() * arr.length)];
  }

  choices(arr, { weights } = {}) {
    if (!weights) return [this.choice(arr)];
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this._next() * total;
    for (let i = 0; i < arr.length; i++) {
      r -= weights[i];
      if (r <= 0) return [arr[i]];
    }
    return [arr[arr.length - 1]];
  }

  uniform(lo, hi) {
    return lo + this._next() * (hi - lo);
  }
}

// ---------------------------------------------------------------------------
// LOAD SEEDS
// ---------------------------------------------------------------------------

function loadSeeds(seedDir) {
  const categories = {};
  const catDir = join(seedDir, 'categories');
  for (const f of readdirSync(catDir).filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(catDir, f), 'utf8'));
    categories[data.slug] = data;
  }
  const merchants = JSON.parse(readFileSync(join(seedDir, 'merchants_seed.json'), 'utf8')).merchants;
  const customers = JSON.parse(readFileSync(join(seedDir, 'customers_seed.json'), 'utf8')).customers;
  const triggers  = JSON.parse(readFileSync(join(seedDir, 'triggers_seed.json'),  'utf8')).triggers;
  return { categories, merchants, customers, triggers };
}

// ---------------------------------------------------------------------------
// EXPAND MERCHANTS (10 per category, 50 total)
// ---------------------------------------------------------------------------

function expandMerchants(seeds, rnd) {
  const expanded = [...seeds];
  const byCategory = {};
  for (const m of seeds) byCategory[m.category_slug] = (byCategory[m.category_slug] || []).concat(m);

  let nextIdx = seeds.length + 1;
  const cities = Object.keys(LOCALITIES);

  for (const catSlug of Object.keys(NAME_BANKS)) {
    const existing = (byCategory[catSlug] || []).length;
    const need = 10 - existing;
    for (let i = 0; i < need; i++) {
      const [ownerFirst, bizName] = rnd.choice(NAME_BANKS[catSlug]);
      const city = rnd.choice(cities);
      const locality = rnd.choice(LOCALITIES[city]);
      const safeName = ownerFirst.toLowerCase().replace(/\s+/g,'_').replace('dr.','dr');
      const mid = `m_${String(nextIdx).padStart(3,'0')}_${safeName}_${catSlug.replace(/s$/,'')}_${city.toLowerCase()}`;

      const views = rnd.randint(400, 6000);
      const calls = rnd.randint(2, Math.max(3, Math.floor(views / 80)));
      const ctr = Math.round(rnd.uniform(0.015, 0.060) * 1000) / 1000;
      const verified = rnd.random() > 0.25;
      const subStatus = rnd.choices(['active','expired','trial'], { weights: [7, 2, 1] })[0];
      const extraLangs = city === 'Mumbai' ? ['mr'] : city === 'Chennai' ? ['ta'] : city === 'Hyderabad' ? ['te'] : city === 'Bangalore' ? ['kn'] : [];

      expanded.push({
        merchant_id: mid,
        category_slug: catSlug,
        identity: {
          name: bizName, city, locality,
          place_id: `ChIJ_${locality.toUpperCase().replace(/\s/g,'_')}_${catSlug.toUpperCase()}_${String(nextIdx).padStart(3,'0')}`,
          verified,
          languages: ['en', 'hi', ...extraLangs],
          owner_first_name: ownerFirst,
          established_year: rnd.randint(2010, 2023),
        },
        subscription: {
          status: subStatus,
          plan: subStatus !== 'trial' ? 'Pro' : 'Trial',
          days_remaining: subStatus === 'active' ? rnd.randint(5, 300) : subStatus === 'trial' ? rnd.randint(1, 14) : 0,
          days_since_expiry: subStatus === 'expired' ? rnd.randint(7, 90) : null,
        },
        performance: {
          window_days: 30,
          views, calls,
          directions: calls * 2 + rnd.randint(0, 30),
          ctr,
          leads: rnd.randint(0, calls),
          delta_7d: {
            views_pct: Math.round(rnd.uniform(-0.30, 0.30) * 100) / 100,
            calls_pct: Math.round(rnd.uniform(-0.30, 0.30) * 100) / 100,
          },
        },
        offers: [],
        conversation_history: [],
        customer_aggregate: { total_unique_ytd: rnd.randint(50, 2000) },
        signals: [],
        review_themes: [],
      });
      nextIdx++;
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// EXPAND CUSTOMERS (~4 per merchant, 200 total)
// ---------------------------------------------------------------------------

function expandCustomers(seeds, merchants, rnd) {
  const expanded = [...seeds];
  let nextIdx = seeds.length + 1;
  const havePerMerchant = {};
  for (const c of seeds) havePerMerchant[c.merchant_id] = (havePerMerchant[c.merchant_id] || 0) + 1;

  const NAMES = ['Aarav','Vivaan','Aditya','Vihaan','Arjun','Ishaan','Reyansh','Aryan','Ananya','Aadhya','Saanvi','Kavya','Diya','Ira','Myra','Anika','Riya','Tara'];
  const TARGET = 4;

  for (const m of merchants) {
    const cur = havePerMerchant[m.merchant_id] || 0;
    for (let i = 0; i < Math.max(0, TARGET - cur); i++) {
      if (nextIdx > 200 + seeds.length) break;
      const name = rnd.choice(NAMES);
      const cid = `c_${String(nextIdx).padStart(3,'0')}_${name.toLowerCase()}_for_${m.merchant_id}`;
      const visits = rnd.randint(1, 12);
      const state = rnd.choices(['new','active','lapsed_soft','lapsed_hard','churned'], { weights: [1, 4, 2, 1, 1] })[0];
      expanded.push({
        customer_id: cid,
        merchant_id: m.merchant_id,
        identity: {
          name, phone_redacted: '<phone>',
          language_pref: rnd.choice(['en','hi-en mix','hi']),
          age_band: rnd.choice(['20-25','25-35','30-40','40-50','50-65']),
        },
        relationship: {
          first_visit: '2025-09-01', last_visit: '2026-04-01',
          visits_total: visits, services_received: [],
          lifetime_value: visits * rnd.randint(200, 1500),
        },
        state,
        preferences: { channel: 'whatsapp', reminder_opt_in: rnd.random() > 0.2 },
        consent: { opted_in_at: '2025-09-01', scope: ['promotional_offers'] },
      });
      nextIdx++;
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// EXPAND TRIGGERS (100 total)
// ---------------------------------------------------------------------------

function expandTriggers(seeds, merchants, customers, rnd) {
  const expanded = [...seeds];
  let nextIdx = seeds.length + 1;

  const KINDS = [
    ['research_digest','external','merchant',1],
    ['perf_dip','internal','merchant',3],
    ['perf_spike','internal','merchant',1],
    ['milestone_reached','internal','merchant',1],
    ['dormant_with_vera','internal','merchant',2],
    ['review_theme_emerged','internal','merchant',3],
    ['competitor_opened','external','merchant',2],
    ['festival_upcoming','external','merchant',1],
    ['recall_due','internal','customer',3],
    ['customer_lapsed_soft','internal','customer',3],
    ['appointment_tomorrow','internal','customer',2],
    ['chronic_refill_due','internal','customer',2],
    ['trial_followup','internal','customer',2],
    ['renewal_due','internal','merchant',4],
    ['curious_ask_due','internal','merchant',1],
  ];

  for (const [kind, source, scope, urgency] of KINDS) {
    for (let k = 0; k < 5; k++) {
      if (nextIdx > 100) break;
      const m = rnd.choice(merchants);
      let cust = null;
      if (scope === 'customer') {
        const mCustomers = customers.filter(c => c.merchant_id === m.merchant_id);
        if (!mCustomers.length) continue;
        cust = rnd.choice(mCustomers);
      }
      expanded.push({
        id: `trg_${String(nextIdx).padStart(3,'0')}_${kind}_${m.merchant_id.slice(0,20)}`,
        scope, kind, source,
        merchant_id: m.merchant_id,
        customer_id: cust ? cust.customer_id : null,
        payload: { placeholder: true, metric_or_topic: kind },
        urgency,
        suppression_key: `${kind}:${m.merchant_id}:gen_${nextIdx}`,
        expires_at: '2026-06-30T00:00:00Z',
      });
      nextIdx++;
    }
    if (nextIdx > 100) break;
  }
  return expanded.slice(0, 100);
}

// ---------------------------------------------------------------------------
// WRITE TEST PAIRS (30 canonical pairs)
// ---------------------------------------------------------------------------

function writeTestPairs(outDir, triggers, rnd) {
  const byKind = {};
  for (const t of triggers) byKind[t.kind] = (byKind[t.kind] || []).concat(t);

  const pairs = [];
  let testId = 1;
  for (const kind of Object.keys(byKind).sort()) {
    for (const t of byKind[kind].slice(0, 2)) {
      pairs.push({
        test_id: `T${String(testId).padStart(2,'0')}`,
        trigger_id: t.id,
        merchant_id: t.merchant_id,
        customer_id: t.customer_id || null,
      });
      testId++;
      if (pairs.length >= 30) break;
    }
    if (pairs.length >= 30) break;
  }

  writeFileSync(join(outDir, 'test_pairs.json'), JSON.stringify({ pairs: pairs.slice(0,30) }, null, 2));
  console.log(`  Wrote test_pairs.json (${pairs.length} pairs)`);
}

// ---------------------------------------------------------------------------
// WRITE ALL OUTPUTS
// ---------------------------------------------------------------------------

function writeOutputs(outDir, categories, merchants, customers, triggers) {
  mkdirSync(join(outDir, 'categories'), { recursive: true });
  for (const [slug, data] of Object.entries(categories)) {
    writeFileSync(join(outDir, 'categories', `${slug}.json`), JSON.stringify(data, null, 2));
  }
  console.log(`  Wrote ${Object.keys(categories).length} categories`);

  mkdirSync(join(outDir, 'merchants'), { recursive: true });
  for (const m of merchants) {
    writeFileSync(join(outDir, 'merchants', `${m.merchant_id}.json`), JSON.stringify(m, null, 2));
  }
  console.log(`  Wrote ${merchants.length} merchants`);

  mkdirSync(join(outDir, 'customers'), { recursive: true });
  for (const c of customers) {
    writeFileSync(join(outDir, 'customers', `${c.customer_id}.json`), JSON.stringify(c, null, 2));
  }
  console.log(`  Wrote ${customers.length} customers`);

  mkdirSync(join(outDir, 'triggers'), { recursive: true });
  for (const t of triggers) {
    writeFileSync(join(outDir, 'triggers', `${t.id}.json`), JSON.stringify(t, null, 2));
  }
  console.log(`  Wrote ${triggers.length} triggers`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const seedDirFlag = args.indexOf('--seed-dir');
const outFlag = args.indexOf('--out');
const seedDir = resolve(seedDirFlag >= 0 ? args[seedDirFlag + 1] : '.');
const outDir  = resolve(outFlag >= 0 ? args[outFlag + 1] : './expanded');

console.log(`Reading seeds from: ${seedDir}`);
console.log(`Writing output to:  ${outDir}`);

const rnd = new SeededRandom(SEED);
const { categories, merchants: mSeeds, customers: cSeeds, triggers: tSeeds } = loadSeeds(seedDir);
console.log(`  Loaded: ${Object.keys(categories).length} categories, ${mSeeds.length} merchant seeds, ${cSeeds.length} customer seeds, ${tSeeds.length} trigger seeds`);

const merchants = expandMerchants(mSeeds, rnd);
const customers = expandCustomers(cSeeds, merchants, rnd);
const triggers  = expandTriggers(tSeeds, merchants, customers, rnd);
console.log(`  Expanded: ${merchants.length} merchants, ${customers.length} customers, ${triggers.length} triggers`);

writeOutputs(outDir, categories, merchants, customers, triggers);
writeTestPairs(outDir, triggers, rnd);
console.log('\nDone!');
