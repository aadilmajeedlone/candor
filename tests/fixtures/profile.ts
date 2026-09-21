import type { Interview, ResumeProfile, UserProfile } from '@shared/types';
import { SAMPLE_FACTS } from './facts';

export function sampleResume(): ResumeProfile {
  return {
    name: 'Riya Sharma',
    headline: 'Operations manager',
    summary: 'Operations manager with 7 years running customer support and fulfilment teams.',
    currentRole: 'Operations Manager at Northwind Logistics',
    yearsExperience: 7,
    roles: [
      {
        title: 'Operations Manager',
        company: 'Northwind Logistics',
        start: '2020',
        current: true,
        responsibilities: [],
        achievements: [],
        metrics: [],
        tools: [],
        leadership: [],
      },
    ],
    skills: ['SQL', 'Excel', 'Power BI', 'Zendesk', 'Jira', 'process mapping'],
    tools: ['Power BI', 'Zendesk'],
    technologies: [],
    education: [{ institution: 'University of Mumbai', degree: 'B.Com', year: '2015' }],
    certifications: ['Lean Six Sigma Green Belt'],
    projects: [],
    metrics: [],
    leadership: [],
    industries: ['Logistics'],
    facts: SAMPLE_FACTS,
  };
}

export function sampleInterview(over: Partial<Interview> = {}): Interview {
  return {
    id: 'int1',
    title: 'Operations Manager @ Contoso',
    jobTitle: 'Operations Manager',
    company: 'Contoso',
    interviewType: 'operations',
    jobDescription:
      'Lead a 40-person operations team. Own SLA, quality and cost metrics. Build dashboards in SQL and Power BI. Partner with engineering and product on process improvement.',
    companyNotes: 'Contoso runs same-day delivery in 12 cities. Culture of ownership.',
    interviewerInfo: '',
    resumeId: 'r1',
    jdAnalysis: {
      jobTitle: 'Operations Manager',
      company: 'Contoso',
      responsibilities: ['Lead a 40-person operations team', 'Own SLA, quality and cost metrics'],
      requiredSkills: ['SQL', 'Power BI', 'people management'],
      preferredSkills: ['Lean Six Sigma'],
      yearsExperience: '5+',
      tools: ['Power BI'],
      technologies: ['SQL'],
      behavioralRequirements: ['ownership'],
      leadershipRequirements: ['coaching'],
      domainKnowledge: ['logistics'],
      keywords: ['SLA', 'KPI'],
      kpis: ['SLA', 'cost per contact'],
      competencies: ['process improvement', 'stakeholder management'],
      method: 'heuristic',
    },
    match: null,
    status: 'ready',
    notes: '',
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

export function sampleProfile(over: Partial<UserProfile> = {}): UserProfile {
  return {
    name: 'Riya Sharma',
    summary: '',
    skills: [],
    experience: '',
    education: '',
    preferredStyle: 'conversational',
    preferredMode: 'standard',
    targetRoles: ['Operations Manager'],
    interviewPreferences: '',
    extraFacts: [],
    updatedAt: 1,
    ...over,
  };
}
