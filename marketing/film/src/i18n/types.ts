export type Fact = {label: string; value: string};

export type Copy = {
  lang: 'he' | 'en';
  brand: string;
  open: {l1: string; l2: string; l3: string; l4: string; emph: string};
  chat: {store: string; status: string; delivered: string};
  verify: {
    c1: string; b1: string; facts: Fact[]; verified: string; h1: string; h2: string; h1dim: string; h2emph: string;
  };
  operate: {
    c2: string; b2: string; linkChip: string;
    rows: {label: string; value: string}[]; // cart, total, consent, authority
    payLabel: string; payPreparing: string; payDone: string;
    flashes: {title: string; detail: string}[];
    t1: string; t2: string;
  };
  authority: {
    c3: string; hold: string; b3: string; cardTitle: string;
    customer: Fact; request: Fact; order: Fact; authority: Fact;
    decision: string; approve: string; decline: string; approved: string;
    t1: string; t2: string;
  };
  supplier: {
    ownerLabel: string; ownerMsg: string; reply: string; usual: string; understood: string;
    nodes: Fact[]; supA: {name: string; tag: string; price: string; lead: string; fit: string};
    supB: {name: string; tag: string; price: string; lead: string; fit: string};
    poTitle: string; poPreparing: string; poAuth: string; poSubmitted: string; poEta: string;
    done: {l1: string; l2: string; l3: string};
  };
  owner: {
    q1: string; title: string;
    items: {n: string; text: string; sub?: string; tag: string; tone: 'potential' | 'hold' | 'alert'}[];
    q2: string;
    outcomes: {label: string; value: string; unit: string; tag: string}[];
    disclaimer: string;
  };
  scale: {words: string[]; one1: string; one2: string};
  brandEnd: {t1: string; t2: string; soon: string; micro: string; t2emph: string};
  demo: string;
};
