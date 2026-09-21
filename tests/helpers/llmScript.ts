// Scripted LLM replies shared by the integration and end-to-end suites.
export const ANSWER = 'In my current role I manage a team of 14 support agents and 3 team leads. I redesigned the returns workflow and cut average handling time by 22%.';

export const RESUME_JSON = {
  name: 'Riya Sharma',
  summary: 'Operations manager with 7+ years running customer support and fulfilment teams in logistics.',
  yearsExperience: 7,
  roles: [
    { title: 'Operations Manager', company: 'Northwind Logistics', current: true, achievements: ['Redesigned the returns workflow, cutting average handling time by 22% across a 40-person operation.'], metrics: ['22%'], tools: ['Power BI'] },
    { title: 'Chief Executive Officer', company: 'Globex', current: false }, // invented: must be discarded
  ],
  skills: ['SQL', 'Power BI', 'Kubernetes'], // Kubernetes is invented
  certifications: ['Lean Six Sigma Green Belt (2021)', 'PMP'], // PMP is invented
  education: [{ institution: 'University of Mumbai', degree: 'B.Com', year: '2015' }],
  facts: [
    { kind: 'achievement', text: 'Cut average handling time by 22% across a 40-person operation', label: 'Northwind Logistics — Operations Manager', evidence: 'Redesigned the returns workflow, cutting average handling time by 22% across a 40-person operation' },
    { kind: 'achievement', text: 'Increased revenue by 300%', label: 'Northwind', evidence: 'Increased revenue by 300% year over year' }, // invented: must be discarded
  ],
};

/** Reply by prompt: structured JSON for analysis tasks, plain text for answers. */
export function respond(body: Record<string, unknown> | null): string {
  const msgs = (body?.messages as { role: string; content: string }[] | undefined) ?? [];
  const system = msgs.find((m) => m.role === 'system')?.content ?? '';
  const user = msgs.find((m) => m.role === 'user')?.content ?? '';
  if (system.includes('extract structured facts from a résumé')) return JSON.stringify(RESUME_JSON);
  if (system.includes('You analyse a job description')) return JSON.stringify({ jobTitle: 'Operations Manager', company: 'Contoso', responsibilities: ['Lead a 40-person operations team'], requiredSkills: ['SQL', 'Power BI', 'Salesforce'], preferredSkills: ['Lean Six Sigma'], yearsExperience: '5+ years', tools: ['Power BI', 'Salesforce'], technologies: ['SQL'], behavioralRequirements: [], leadershipRequirements: ['people management'], domainKnowledge: ['logistics'], keywords: ['SLA'], kpis: ['SLA'], competencies: ['stakeholder management'] });
  if (system.includes('comparing their résumé facts')) {
    const id = /\[([^\]]+)\]/.exec(user)?.[1] ?? 'nope';
    return JSON.stringify({ transferable: [{ requirement: 'Salesforce', fromFactIds: [id, 'invented-id'], explanation: 'CRM-style ticketing experience carries over.' }, { requirement: 'Kubernetes', fromFactIds: ['invented-id'], explanation: 'none' }], likelyQuestions: ['How would you learn Salesforce quickly?'], prepAreas: ['Refresh CRM concepts'] });
  }
  if (system.includes('write interview preparation material')) return JSON.stringify({ tellMeAboutYourself: 'I am an operations manager with seven years in logistics. I managed 14 agents and saved $9 million.', professionalSummary: 'Operations manager.', careerJourney: 'Team lead at Contoso BPO, then Operations Manager at Northwind Logistics.', currentRole: 'I run the returns operation.', strengths: ['Coaching'], relevantExperience: ['Returns workflow redesign'] });
  if (system.includes('prepare a candidate for an interview at a company')) return JSON.stringify({ summary: 'Same-day delivery in 12 cities.', fromYourNotes: ['12 cities'], toResearch: ['Recent news'], questionsToAsk: ['What does success look like?'] });
  if (system.includes('break down a role for interview preparation')) return JSON.stringify({ responsibilities: ['Lead the team'], skillsRequired: ['SQL'], likelyAreas: ['SLA'], terminology: [{ term: 'SLA', meaning: 'Service level agreement' }] });
  if (system.includes('likely interview questions tailored')) return JSON.stringify({ questions: [{ category: 'behavioral', text: 'Tell me about a time you improved a process.', why: 'Process ownership' }, { category: 'hr', text: 'Why do you want to work at Contoso?', why: 'Motivation' }] });
  if (system.includes('professional interviewer running a realistic mock interview')) return 'Tell me about a time you improved a process.';
  if (system.includes('evaluate a candidate')) return JSON.stringify({ relevance: { level: 'strong', note: 'Answers directly.' }, completeness: { level: 'adequate', note: 'No result mentioned.' }, structure: { level: 'adequate', note: 'Loose.' }, conciseness: { level: 'strong', note: 'Right length.' }, covered: ['The situation'], missing: ['A measurable result'], improvements: ['Add the outcome'], improvedAnswer: 'I cut handling time by 22%.' });
  if (system.includes('turn rough notes into a STAR story')) return JSON.stringify({ title: 'Returns redesign', situation: 'Returns were slow.', task: 'Cut handling time.', action: 'Removed two approval steps.', result: 'Handling time fell 22%.', skills: ['process mapping'], tags: ['process'] });
  return ANSWER;
}

