/* vibe waitlist settings. This is the only file you need to edit. */
window.VIBE_CONFIG = {
  // Google Apps Script web app URL (ends in /exec). Paste it here after deploying backend/Code.gs.
  ENDPOINT: "",

  // Public address of this page, used to build referral links. Leave blank to use the current address.
  SITE_URL: "https://roma-luo.github.io/vibe-waitlist/",

  // Headline A/B test. Each visitor is randomly given one of ACTIVE_VARIANTS and keeps it.
  // Force one with ?v=a in the link (useful when an ad's creative matches a headline).
  HEADLINES: {
    a: "A spark. That feels like you.",
    b: "Stop swiping. Start vibing.",
    c: "Meet people through their stories, not their selfies."
  },
  // Two variants split small traffic less thinly than three. Add "c" if you have the visitors.
  ACTIVE_VARIANTS: ["a", "b"],

  // Show "Join N people on the list" only once the real count reaches this number.
  COUNT_THRESHOLD: 100,

  // Optional ad pixels. Leave blank to skip. A successful sign-up fires Lead (Meta) and CompleteRegistration (TikTok).
  META_PIXEL_ID: "",
  TIKTOK_PIXEL_ID: "",

  // Optional social links shown in the footer. Leave blank to hide.
  SOCIAL: { instagram: "", tiktok: "" },

  // Optional contact email shown on the privacy page.
  CONTACT_EMAIL: ""
};
