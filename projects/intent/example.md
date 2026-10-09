# Acme Web: UI intent

A generic example. Replace each section with what you derived from the
project's design doc, tokens and sibling screens, plus the answers the user
gave to the gaps you could not derive.

## Purpose and users

Acme Web is a small account-based web app. Visitors read the home page and sign
in; signed-in users manage their settings and profile. Most visits are short
and task-focused, on phones and on laptops.

## Tone and direction

Calm, plain and trustworthy. Generous white space, one accent colour for the
primary action, no decorative gradients or glass effects.

## Constraints

- Text meets WCAG AA contrast on every background.
- Tap targets are at least 44 px.
- Body text is never smaller than 14 px.
- Colours, spacing and radii come from `src/styles/tokens.css`; no hardcoded
  values in components.

## Baseline for consistency

The settings page is the anchor for every account page: same page shell, same
header, same form controls from the `atoms` barrel.

## Known intentional deviations

- The home page hero uses a wider measure than the content pages. This is
  deliberate and is not a finding.
