import { buildInterviewContext, type InterviewContext } from '@core/live/context';
import type { Interview, ResumeProfile, Story, UserProfile } from '@shared/types';
import type { Repos } from '../db/repos';

export interface LoadedMaterial {
  interview: Interview | null;
  resume: ResumeProfile | null;
  resumeText: string;
  profile: UserProfile;
  stories: Story[];
}

/** Gather everything the model may draw on for an interview (or the general profile when no interview is chosen). */
export function loadMaterial(repos: Repos, interviewId: string | null): LoadedMaterial {
  const interview = interviewId ? repos.getInterview(interviewId) : null;
  const resumeRec = interview?.resumeId ? repos.getResume(interview.resumeId) : (repos.listResumes()[0] ? repos.getResume(repos.listResumes()[0].id) : null);
  return {
    interview,
    resume: resumeRec?.profile ?? null,
    resumeText: resumeRec?.rawText ?? '',
    profile: repos.getProfile(),
    stories: repos.listStories(),
  };
}

export function loadContext(repos: Repos, interviewId: string | null): { ctx: InterviewContext; material: LoadedMaterial } {
  const material = loadMaterial(repos, interviewId);
  const ctx = buildInterviewContext({
    interview: material.interview,
    resume: material.resume,
    profile: material.profile,
    stories: material.stories,
    customInstructions: repos.getSettings().customInstructions,
  });
  return { ctx, material };
}
