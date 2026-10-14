// Pure helpers for the Session reviews panel.

const isOpen = (s) => s.dismissedAt == null;
const openSuggestions = (review) => review.suggestions.filter(isOpen);
const dismissedSuggestions = (review) => review.suggestions.filter((s) => !isOpen(s));
// True when the review has suggestions and the user has dismissed every one.
const allDismissed = (review) => review.suggestions.length > 0 && openSuggestions(review).length === 0;
const countWithOpen = (reviews) => reviews.filter((r) => openSuggestions(r).length > 0).length;
const DISMISSAL_TEXT = { done: 'Marked done', not_useful: 'Marked not useful', duplicate: 'Marked duplicate' };
const dismissalText = (s) => DISMISSAL_TEXT[s.reason] ?? 'Marked not useful';

// The prompt the Copy prompt button puts on the clipboard, for a stronger model to
// check Haiku's suggestions against the transcript. Dismissed suggestions are left
// out. Null when the review has no transcript path, or when every suggestion is
// dismissed, because there is nothing left to check. A failed review or one with no
// suggestions gets a prompt that asks for suggestions instead of a check.
function reviewPrompt(review) {
  if (!review.transcript || allDismissed(review)) return null;
  const intro = `Review the Claude Code session transcript at ${review.transcript}.`;
  if (review.status === 'failed' || !review.suggestions.length) {
    const what = review.status === 'failed' ? 'failed' : 'made no suggestions';
    return `${intro} A Haiku review of it ${what}.\nWhat would you suggest, and why might Haiku have missed it?`;
  }
  const lines = openSuggestions(review).map((s) => `- ${s.text}`).join('\n');
  return `${intro} A Haiku review of it suggested:\n${lines}\nWhich of these are right, which are wrong, and what did it miss?`;
}

export { reviewPrompt, openSuggestions, dismissedSuggestions, allDismissed, countWithOpen, dismissalText };
