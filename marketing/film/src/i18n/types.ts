export type Fact = {label: string; value: string};
export type Chip = {label: string; value?: string};

export type Copy = {
  lang: 'he' | 'en';
  brand: string;
  barry: string; // how Barry's name appears in UI
  activeNow: string;
  customerOf: string; // e.g. "Customer · Onyx Studio"
  now: string;

  morning: {
    employee: string; employeeMsg: string;
    b1: string; b2: string; b3: string;
    log: {t: string; text: string}[];
    t1: string; t2: string;
  };
  dress: {
    customer: string;
    c1: string; b1: string;
    facts: Fact[];
    c2: string; b2: string;
    link: {title: string; sub: string; price: string};
    paid: string;
    ledger: Fact[]; // cart, total, consent, payment, order
    paymentCreated: string; paymentVerified: string;
  };
  patience: {
    customer: string; messages: string;
    history: {who: 'c' | 'b'; text: string; time: string}[];
    burst: string[];
    reply: string;
    track: {warehouse: string; courier: string; you: string; checked: string; transit: string; eta: string; etaValue: string};
    t1: string; t2: string;
  };
  close5: {
    customer: string;
    c1: string; b1: string; c2: string;
    orderValue: Fact; authority: string; discount: Fact; margin: Fact;
    after: Fact[]; // converted, payment, order
  };
  escalate: {
    customer: string;
    c1: string; b1: string; c2: string; b2: string; paid: string;
    card: {title: string; from: string; rows: Fact[]; approve: string; keep: string; approved: string};
    t1: string; t2: string;
  };
  owner: {
    q1: string; b1: string; b2: string; b3: string;
    strip: Fact[];
    q2: string; b4: string;
    outcomes: {label: string; value: string; unit: string}[];
    verified: string;
  };
  supplier: {
    ownerLabel: string; ownerMsg: string; reply: string; usual: string; understood: string;
    nodes: Fact[];
    supA: {name: string; tag: string; units: string; price: string; eta: string};
    supB: {name: string; tag: string; units: string; price: string; eta: string};
    reasons: string[];
    poTitle: string; poPreparing: string; poAuth: string; poSubmitted: string; poEta: string;
    done: {l1: string; l2: string};
  };
  margins: {
    notif: string; feature: string;
    sweepLabel: string; sweep: {area: string; flag?: string}[]; ok: string;
    leadLabel: string; current: string; currentUnit: string; why: string;
    saving: string; savingUnit: string; actions: string[];
    moreLabel: string; more: {what: string; saving: string}[];
    totalLabel: string; total: string;
    t1: string; t2: string;
  };
  montage: {kind: string; name: string; msg: string; chips: string[]}[];
  systems: {modules: string[]; w1: string; w2: string; w3: string};
  adapt: {l1: string; l2: string};
  night: {events: Fact[]; t: string};
  nextDay: {b1: string; b2: string; employeeMsg: string};
  brandEnd: {works: string; soon: string};
  demo: string;
};
