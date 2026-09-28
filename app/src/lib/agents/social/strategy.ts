/**
 * Content strategy and research - a scripted, deterministic stand-in for what a real research
 * step would do (look at audience data, competitors, trends). No AI call, no network access:
 * it works entirely from the input it is given.
 */

export interface StrategyInput {
  topic: string;
  audience?: string;
  competitorNotes?: string[];
}

export interface ContentPillar {
  title: string;
  angle: string;
}

/** Always produces the same three angles for a given topic - deterministic, not "creative". */
export function researchStrategy(input: StrategyInput): ContentPillar[] {
  const audience = input.audience?.trim() || 'your customers';
  const topic = input.topic.trim();
  return [
    { title: `Why ${topic} matters`, angle: `Explain, in plain language, why ${audience} should care about ${topic}.` },
    { title: `${topic}: a before and after`, angle: `Show the difference ${topic} makes for ${audience}, concretely.` },
    { title: `Common questions about ${topic}`, angle: `Answer the questions ${audience} actually ask, directly.` },
  ];
}
