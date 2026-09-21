import type { Fact } from '@shared/types';

/** Fictional candidate used across tests. No real person's data. */
let n = 0;
const f = (kind: Fact['kind'], text: string, label = 'Northwind Logistics — Operations Manager', tags: string[] = []): Fact => ({
  id: `f${++n}`,
  kind,
  text,
  source: 'resume',
  label,
  evidence: text,
  tags,
});

export const SAMPLE_FACTS: Fact[] = [
  f('achievement', 'Redesigned the returns workflow and cut average handling time by 22% across a 40-person operation'),
  f('achievement', 'Built a weekly KPI dashboard in Power BI tracking SLA, backlog and first-contact resolution for 6 client accounts'),
  f('responsibility', 'Managed a team of 14 support agents and 3 team leads, running weekly one-to-ones and quarterly performance reviews'),
  f('achievement', 'Resolved a major escalation with an enterprise client after a missed delivery SLA, restoring the account and a renewal worth $1.2M'),
  f('leadership', 'Mentored 5 agents into team-lead roles through a structured coaching programme'),
  f('achievement', 'Introduced a QA scorecard and calibration sessions that raised quality scores from 82% to 94% in two quarters'),
  f('responsibility', 'Coordinated with engineering and product to prioritise the top 10 recurring customer defects each sprint'),
  f('achievement', 'Automated the daily reporting pack with Excel macros and SQL queries, saving the team 12 hours a week'),
  f('skill', 'Skills: SQL, Excel (pivot tables, VLOOKUP), Power BI, Zendesk, Jira, process mapping, Lean Six Sigma Green Belt'),
  f('education', 'B.Com, University of Mumbai, 2015', 'Education'),
  f('certification', 'Lean Six Sigma Green Belt (2021); Google Data Analytics Certificate (2022)', 'Certifications'),
  f('achievement', 'Handled peak-season volume 3x normal by re-forecasting staffing and cross-training 20 agents, holding SLA at 96%', 'Northwind Logistics — Operations Manager'),
  f('responsibility', 'Owned the vendor relationship with the BPO partner, negotiating a 9% reduction in cost per contact', 'Contoso BPO — Team Lead'),
  f('achievement', 'Led a change-management rollout of a new ticketing system to 60 users with training, documentation and a two-week hypercare', 'Contoso BPO — Team Lead'),
];

export const SAMPLE_STORIES = [
  {
    id: 's1',
    title: 'Difficult stakeholder: enterprise client escalation',
    text: 'Situation: An enterprise client threatened to leave after a missed delivery SLA. Task: Restore trust and keep the renewal. Action: I ran a root-cause review with the client, set up a daily status call and re-routed their orders to a dedicated pod. Result: SLA recovered within three weeks and the $1.2M renewal was signed.',
  },
  {
    id: 's2',
    title: 'Process improvement: returns workflow redesign',
    text: 'Situation: Returns took too long and the backlog kept growing. Task: Reduce handling time. Action: I mapped the process, removed two approval steps and introduced a triage queue. Result: Handling time fell 22% and backlog cleared in a month.',
  },
];
