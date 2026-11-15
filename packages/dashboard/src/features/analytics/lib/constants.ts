export const ANALYTICS_SETUP_PROMPT =
  'I want to add product analytics to this project. Read the current directory and set up PostHog analytics with the posthog-js SDK, using the PostHog project key and host from the Analytics page of my Mojobase dashboard.';

// Self-hosted: the bare command can only hand off an existing connection — it
// cannot create one (the key is the admin's, and must not travel through an
// agent conversation). Tell the agent what to do instead of letting it flail.
export const ANALYTICS_SETUP_PROMPT_SELF_HOSTED =
  'I want to add product analytics to this project. Read the current directory and set up PostHog analytics with the posthog-js SDK, using the PostHog project key and host from the Analytics page of my Mojobase dashboard. If it reports PostHog is not connected, stop and ask me to connect it from the Analytics page of my Mojobase dashboard first.';
