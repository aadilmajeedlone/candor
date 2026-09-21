/** Vocabulary used by the heuristic résumé/JD analysers. Deliberately generic: business, ops, data and software roles. */

export const KNOWN_TOOLS: string[] = [
  'Excel', 'Google Sheets', 'SQL', 'MySQL', 'PostgreSQL', 'Oracle', 'MongoDB', 'Python', 'R', 'Java', 'JavaScript', 'TypeScript', 'C#', 'C++', 'Go', 'Ruby', 'PHP', 'Scala', 'Kotlin', 'Swift',
  'React', 'Angular', 'Vue', 'Node.js', 'Django', 'Flask', 'Spring', '.NET', 'Docker', 'Kubernetes', 'Terraform', 'Git', 'GitHub', 'GitLab', 'Jenkins', 'Linux',
  'AWS', 'Azure', 'GCP', 'Snowflake', 'BigQuery', 'Redshift', 'Databricks', 'Spark', 'Hadoop', 'Airflow', 'dbt', 'Kafka',
  'Power BI', 'Tableau', 'Looker', 'Qlik', 'Google Analytics', 'Mixpanel', 'Amplitude', 'Metabase', 'Grafana', 'Splunk', 'Datadog',
  'Salesforce', 'HubSpot', 'Zendesk', 'Freshdesk', 'Intercom', 'ServiceNow', 'Jira', 'Confluence', 'Asana', 'Trello', 'Monday.com', 'Notion', 'Slack', 'Smartsheet', 'Airtable',
  'SAP', 'NetSuite', 'Workday', 'QuickBooks', 'Kronos', 'ADP', 'Genesys', 'Five9', 'NICE', 'Avaya', 'Twilio', 'Zoom', 'Teams',
  'Figma', 'Photoshop', 'Canva', 'Adobe Analytics', 'SEMrush', 'Marketo', 'Mailchimp', 'Shopify', 'Magento', 'WordPress',
  'Lean Six Sigma', 'Six Sigma', 'Kaizen', 'Agile', 'Scrum', 'Kanban', 'ITIL', 'PMP', 'Prince2', 'OKR', 'KPI', 'SLA', 'CRM', 'ERP', 'ETL', 'A/B testing', 'Machine Learning', 'NLP',
  'Macros', 'VBA', 'Pivot tables', 'VLOOKUP', 'Process mapping', 'Root cause analysis', 'Forecasting', 'Workforce management', 'Capacity planning', 'Quality assurance', 'Stakeholder management', 'Vendor management', 'Change management',
];

export const KNOWN_COMPETENCIES: string[] = [
  'leadership', 'communication', 'problem solving', 'problem-solving', 'stakeholder management', 'ownership', 'analytical', 'customer focus', 'customer obsession', 'adaptability',
  'collaboration', 'teamwork', 'decision making', 'decision-making', 'time management', 'prioritization', 'prioritisation', 'attention to detail', 'creativity', 'innovation', 'initiative',
  'accountability', 'negotiation', 'conflict resolution', 'coaching', 'mentoring', 'strategic thinking', 'critical thinking', 'process improvement', 'continuous improvement', 'project management',
  'people management', 'change management', 'data-driven', 'cross-functional', 'presentation', 'influencing', 'resilience', 'bias for action', 'dive deep', 'deliver results',
];

export const KPI_WORDS = /\b(sla|kpi|csat|nps|aht|fcr|ces|oee|otif|on-time|turnaround|throughput|utili[sz]ation|churn|retention|revenue|gross margin|cost per|conversion|backlog|first[- ]contact resolution|handle time|quality score|attrition|productivity|efficiency|accuracy|uptime|latency|roi|ebitda|arr|mrr)\b/i;

export const TITLE_WORDS =
  /\b(manager|lead|leader|analyst|engineer|associate|specialist|director|executive|officer|consultant|coordinator|supervisor|agent|intern|head|developer|designer|administrator|assistant|representative|advisor|architect|scientist|owner|partner|president|vp|founder|trainer|recruiter|accountant|auditor|planner|technician|programmer|strategist|instructor|teacher|nurse|clerk)\b/i;

export const LEADERSHIP_VERBS = /\b(led|lead|leading|managed|manage|managing|mentored|mentor|coached|coach|supervised|supervis\w+|trained|train|directed|oversaw|oversee|hired|onboarded|delegated|built a team|head of|responsible for a team|team of)\b/i;

export const ACHIEVEMENT_VERBS = /\b(increased|reduced|improved|saved|delivered|launched|built|won|grew|achieved|cut|boosted|generated|streamlined|automated|eliminated|exceeded|surpassed|accelerated|optimi[sz]ed|scaled|introduced|redesigned|implemented|resolved|turned around|recovered|raised|lowered|decreased)\b/i;

export const NUMBER_UNIT = /(?:[$€£₹]\s?)?\d[\d,]*(?:\.\d+)?\s?(?:%|percent|k\b|m\b|million|billion|crore|lakh|x\b|hours?|hrs?|days?|weeks?|months?|years?|agents|people|members|clients|customers|accounts|tickets|users|stores|sites|countries|cities|reports)?/gi;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Find dictionary terms in text, respecting word boundaries (so "R" or "Go" do not match inside words). */
export function findTerms(text: string, terms: string[]): string[] {
  const found: string[] = [];
  for (const t of terms) {
    const re = new RegExp(`(^|[^A-Za-z0-9+#.])${escapeRe(t)}(?![A-Za-z0-9+#])`, t.length <= 2 ? '' : 'i');
    if (re.test(text)) found.push(t);
  }
  return found;
}
