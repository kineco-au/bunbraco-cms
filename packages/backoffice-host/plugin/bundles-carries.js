/**
 * What a bundle adds, as the Marketplace and Installed views both show it.
 */
import { html } from '@umbraco-cms/backoffice/external/lit'

/** What a bundle adds, in the words of someone choosing one. */
export const CARRIES_LABELS = {
  extensions: 'Screens',
  content: 'Content',
  server: 'Server features',
}

export const carriesTags = (carries) =>
  Object.entries(CARRIES_LABELS)
    .filter(([key]) => carries?.[key])
    .map(([, label]) => html`<uui-tag look="secondary">${label}</uui-tag>`)
