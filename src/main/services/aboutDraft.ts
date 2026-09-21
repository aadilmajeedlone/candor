import type { AboutMePrep, Interview } from '@shared/types';
import { truncate } from '@shared/util';
import type { LoadedMaterial } from './context';

/**
 * An offline draft of the "About me" material, assembled only from what is already in the résumé: its summary, the
 * role titles and companies, and the achievements and responsibilities written under them. Nothing is invented and
 * nothing is worded as a claim the résumé does not make. It exists so that a reply the model could not finish never
 * leaves the page empty: the person still gets an honest starting point, clearly labelled as such.
 */

const withStop = (s: string): string => {
  const t = s.trim().replace(/\s+/g, ' ');
  return /[.!?]$/.test(t) ? t : `${t}.`;
};
const article = (s: string): string => (/^[aeiou]/i.test(s.trim()) ? 'an' : 'a');
/** Résumé bullets are often fragments ("Cut handling time by 22%"); keep them as written. */
const firstOf = (xs: string[], n: number): string[] => xs.map((x) => x.trim()).filter(Boolean).slice(0, n);

export function draftAbout(interview: Interview | null, m: LoadedMaterial): AboutMePrep {
  const r = m.resume;
  const roles = r?.roles ?? [];
  const current = roles.find((x) => x.current) ?? roles[0];
  const name = (r?.name || m.profile.name || '').trim();
  const years = r?.yearsExperience ? Math.round(r.yearsExperience) : 0;
  const target = interview?.jobTitle ? `${interview.jobTitle}${interview.company ? ` at ${interview.company}` : ''}` : '';

  const currentLine = current ? `${article(current.title)} ${current.title} at ${current.company}` : (r?.currentRole ?? '');
  const currentDetail = firstOf(current?.achievements.length ? current.achievements : (current?.responsibilities ?? []), 2).map(withStop);

  const professionalSummary = r?.summary?.trim() ? truncate(r.summary.trim(), 320) : current ? withStop(`${current.title} at ${current.company}${years ? ` with about ${years} years of experience` : ''}`) : '';

  const currentRole = current ? [withStop(`I am ${currentLine}`), ...currentDetail].join(' ') : '';

  // Oldest first, as a story: "I started as … then …".
  const ordered = [...roles].reverse();
  const careerJourney = ordered
    .slice(-5)
    .map((x, i) => withStop(`${i === 0 ? 'I worked' : 'Then I worked'} as ${x.title} at ${x.company}${x.start ? ` (${x.start}${x.end ? `–${x.end}` : x.current ? '–now' : ''})` : ''}`))
    .join(' ');

  const strong = (interview?.match?.strong ?? []).map((s) => s.requirement).filter(Boolean);
  const strengths = firstOf(strong.length >= 3 ? strong : [...strong, ...(r?.skills ?? [])], 6);

  const achievements = roles.flatMap((x) => x.achievements);
  const facts = (r?.facts ?? []).filter((f) => f.kind === 'achievement').map((f) => f.text);
  const relevantExperience = firstOf([...achievements, ...facts], 6);

  const tellMeAboutYourself = [
    name ? withStop(`I am ${name}`) : '',
    current ? withStop(`I am currently ${currentLine}${years ? `, with about ${years} years of experience` : ''}`) : '',
    ...currentDetail.slice(0, 1),
    target ? withStop(`I am applying for the ${target} role, which builds on this experience`) : '',
  ]
    .filter(Boolean)
    .join(' ');

  return { tellMeAboutYourself, professionalSummary, careerJourney, currentRole, strengths, relevantExperience };
}
