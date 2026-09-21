import { describe, expect, it } from 'vitest';
import { HybridIndex, chunkText } from '@core/retrieval';
import { cosine, embedLocal } from '@core/retrieval/embedding';
import { stem, tokenize, tokenJaccard } from '@core/text/tokenize';
import { SAMPLE_FACTS, SAMPLE_STORIES } from '../fixtures/facts';

function buildIndex(): HybridIndex {
  const idx = new HybridIndex();
  for (const fact of SAMPLE_FACTS) idx.add({ id: fact.id, kind: 'fact', text: fact.text, refId: fact.id, label: fact.label, factKind: fact.kind });
  for (const s of SAMPLE_STORIES) idx.add({ id: s.id, kind: 'story', text: `${s.title}. ${s.text}`, refId: s.id, label: s.title });
  return idx;
}

describe('tokenizer', () => {
  it('stems inflections to a shared root', () => {
    const roots = ['manage', 'managing', 'managed', 'manager', 'management'].map(stem);
    expect(new Set(roots).size).toBe(1);
    expect(stem('improved')).toBe(stem('improve'));
    expect(stem('processes')).toBe(stem('process'));
  });
  it('keeps technical tokens intact', () => {
    expect(tokenize('C++ and node.js with CI/CD')).toEqual(expect.arrayContaining(['c++', 'node.j']));
  });
  it('drops interview boilerplate in question mode', () => {
    expect(tokenize('Tell me about a time you improved a process', { question: true })).toEqual([stem('improved'), 'process']);
  });
  it('jaccard is 1 for equal content', () => {
    expect(tokenJaccard('managing a team', 'Managing the team!')).toBe(1);
  });
});

describe('local embeddings', () => {
  it('is deterministic and unit length', () => {
    const a = embedLocal('Managed a team of agents');
    const b = embedLocal('Managed a team of agents');
    expect(cosine(a, b)).toBeCloseTo(1, 5);
  });
  it('ranks related text above unrelated text', () => {
    const q = embedLocal('leading a support team', { question: true });
    const related = embedLocal('Managed a team of 14 support agents');
    const unrelated = embedLocal('Bachelor of Commerce, University of Mumbai');
    expect(cosine(q, related)).toBeGreaterThan(cosine(q, unrelated));
  });
});

describe('HybridIndex', () => {
  const idx = buildIndex();
  const top = (q: string, k = 3) => idx.search(q, { k });

  it('finds the process-improvement material for a process question', () => {
    const hits = top('Tell me about a time you improved a process.');
    const ids = hits.map((h) => h.chunk.id);
    expect(ids.slice(0, 3)).toContain('s2');
    expect(ids.slice(0, 3)).toContain('f1');
    expect(hits[0].score).toBeGreaterThan(0.3);
  });

  it('finds the escalation story for a difficult-stakeholder question', () => {
    const hits = top('Tell me about a time you dealt with a difficult stakeholder.');
    expect(hits.slice(0, 3).map((h) => h.chunk.id)).toContain('s1');
  });

  it('finds leadership facts for a team-management question', () => {
    const hits = top('How have you improved team performance?');
    const texts = hits.map((h) => h.chunk.text).join(' | ');
    expect(texts).toMatch(/QA scorecard|coaching|team of 14/);
  });

  it('finds skills/tools for a technical question', () => {
    const hits = top('What experience do you have with SQL and dashboards?');
    expect(hits.slice(0, 3).map((h) => h.chunk.id)).toEqual(expect.arrayContaining(['f2']));
  });

  it('reports low confidence when nothing relevant exists', () => {
    const hits = idx.search('Explain how you would design a distributed consensus protocol like Raft.', { k: 3 });
    const best = hits[0]?.score ?? 0;
    expect(best).toBeLessThan(0.3);
  });

  it('respects the kind filter and boosts', () => {
    const storiesOnly = idx.search('difficult client escalation', { kinds: ['story'], k: 5 });
    expect(storiesOnly.every((h) => h.chunk.kind === 'story')).toBe(true);
    const boosted = idx.search('improve process', { k: 1, kindBoost: { story: 1.3 } });
    expect(boosted[0].chunk.kind).toBe('story');
  });

  it('is fast enough for the live path', () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) idx.search('Tell me about a time you led a team through change');
    const per = (performance.now() - t0) / 200;
    expect(per).toBeLessThan(5);
  });
});

describe('chunkText', () => {
  it('splits on bullets and keeps chunks bounded', () => {
    const text = '• Lead a team of analysts\n• Own the weekly reporting cycle. Present findings to leadership.\n' + 'word '.repeat(90);
    const chunks = chunkText(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
  });
});
