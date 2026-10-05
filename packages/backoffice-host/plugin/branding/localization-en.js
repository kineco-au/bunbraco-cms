/**
 * The strings that name the product, in the flows bunbraco actually has.
 *
 * A `localization` extension rather than a patched `assets/lang/en.js`: the
 * vendored client is served unmodified, and `vendor:backoffice` would overwrite
 * any edit to it on the next upgrade. Overriding through the extension point
 * survives that.
 *
 * Registered with a weight **below** the core dictionary's, because the registry
 * sorts highest-to-lowest and applies in that order — so the lowest weight is the
 * one that wins. See `localization.registry.js`: `$weight: extension.weight ?? 100`.
 *
 * Only what a person reads in a flow this CMS implements. Strings about
 * `appsettings.json`, IIS permissions, Examine or the .NET installer are left
 * alone: they name real things that are not ours to rename, and the features they
 * belong to are not built.
 *
 * `sections` and `packager` are the other kind of rename: not the product's name
 * but a feature's. Umbraco's Packages section builds a `.umb` file; the artifact
 * here is a bundle (`docs/17-bundles.md`), so the section and the flow that
 * builds one say so. `build-localizations.ts` reads this file for its key set and
 * rewrites only values that name the product, so these pass through untouched and
 * every other language keeps its own word.
 */
export default {
  login: {
    instruction: 'Sign in to Bunbraco',
    userInviteWelcomeMessage:
      "Hello there and welcome to Bunbraco! In just 1 minute you'll be good to go, we just need you to setup a password.",
    userInviteExpiredMessage:
      'Welcome to Bunbraco! Unfortunately your invite has expired. Please contact your administrator to get a new one.',
  },
  user: {
    changePasswordDescription:
      "You can change your password for accessing the Bunbraco backoffice by filling out the form below and click the 'Change Password' button",
    createUserHelp:
      'Create new users to give them access to Bunbraco. When a new user is created a password will be generated that you can share with them.',
    inviteUserHelp:
      'Invite new users to give them access to Bunbraco. An invite email will be sent to the user with information on how to log in.',
    noConsole: 'Disable Bunbraco Access',
    userCreatedSuccessHelp:
      'The new user has successfully been created. To log in to Bunbraco use the password below.',
    userInvitedSuccessHelp:
      'An invitation has been sent to the new user with details about how to log in to Bunbraco.',
    userinviteWelcomeMessage:
      "Hello there and welcome to Bunbraco! In just 1 minute you'll be good to go, we just need you to setup a password and add a picture for your avatar.",
    userinviteExpiredMessage:
      'Welcome to Bunbraco! Unfortunately your invite has expired. Please contact your administrator to get a new one.',
  },
  general: {
    umbracoInfo: 'Bunbraco info',
  },
  buttons: {
    // The accessible name of the header logo button, on every page of the editor.
    // Nothing renders it as visible text, which is why the first sweep through
    // these dictionaries missed it; it surfaced in the accessibility snapshot
    // attached to an unrelated Playwright failure.
    viewSystemDetails: 'View Bunbraco system information and version number',
  },
  visuallyHiddenTexts: {
    searchOverlayTitle: 'Search the Bunbraco backoffice',
  },
  dashboardTabs: {
    contentIntro: 'Welcome to Bunbraco',
  },
  languages: {
    defaultLanguageHelp: 'A Bunbraco site can only have one default language set.',
  },
  member: {
    externalMemberDescription:
      'This member is managed by an external authentication provider. Identity data such as email and username is maintained by the provider, not Bunbraco.',
  },
  paste: {
    errorMessage:
      "The text you're trying to paste contains special characters or formatting. This could be caused by copying text from Microsoft Word. Bunbraco can remove special characters or formatting automatically, so the pasted content will be more suitable for the web.",
  },
  dashboard: {
    nothinghappens: "If Bunbraco isn't opening, you might need to allow popups from this site",
  },
  sections: {
    packages: 'Bundles',
  },
  packager: {
    createPackage: 'Create bundle',
    noPackagesCreated: 'No bundles have been created yet',
  },
  defaultdialogs: {
    linkYourConfirm:
      'You are about to link your Bunbraco and {0} accounts and you will be redirected to {0} to complete the process.',
    unLinkYourConfirm:
      'You are about to un-link your Bunbraco and {0} accounts and you will be logged out.',
  },
}
