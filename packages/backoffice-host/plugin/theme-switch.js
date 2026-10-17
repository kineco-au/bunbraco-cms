/**
 * Light, dark or the computer's choice, from the header (story 049).
 *
 * The choice is Umbraco's theme context's — it links the stylesheet and keeps
 * the alias in `localStorage` for the shell's early script to apply before the
 * next paint. This adds the menu, and keeps the choice for the person in user
 * data, so it follows them to another browser.
 */
import { css, html } from '@umbraco-cms/backoffice/external/lit'
import { UmbLitElement } from '@umbraco-cms/backoffice/lit-element'
import { UMB_THEME_CONTEXT } from '@umbraco-cms/backoffice/themes'

const USER_DATA = '/umbraco/management/api/v1/user-data'
const GROUP = 'crombolo'
const IDENTIFIER = 'theme'
const EARLY = 'crombolo-early-theme'

const CHOICES = [
  { alias: 'umb-light-theme', label: 'Light', icon: 'icon-sunny' },
  { alias: 'Crombolo.Theme.Dark', label: 'Dark', icon: 'icon-contrast' },
  { alias: 'Crombolo.Theme.System', label: 'Match my system', icon: 'icon-lightbulb' },
]

export default class CromboloThemeSwitchElement extends UmbLitElement {
  static properties = { _alias: { state: true } }

  #context
  #savedKey

  constructor() {
    super()
    this._alias = 'umb-light-theme'
    this.consumeContext(UMB_THEME_CONTEXT, (context) => {
      this.#context = context
      this.observe(context.theme, (alias) => {
        this._alias = alias || 'umb-light-theme'
        // The shell's early stylesheet stood in until the context took over;
        // once the choice differs from it, it would only fight the new one.
        const early = document.getElementById(EARLY)
        if (early && early.dataset.theme !== this._alias) early.remove()
      })
      this.#restore()
    })
  }

  /** The person's saved choice, when this browser's differs from it. */
  async #restore() {
    try {
      const query = new URLSearchParams({ groups: GROUP, identifiers: IDENTIFIER, take: '1' })
      const response = await fetch(`${USER_DATA}?${query}`, { credentials: 'include' })
      if (!response.ok) return
      const found = (await response.json()).items?.[0]
      if (!found) return
      this.#savedKey = found.key
      if (found.value && found.value !== this._alias) this.#context?.setThemeByAlias(found.value)
    } catch {
      // This browser's choice stands.
    }
  }

  async #save(alias) {
    const body = { group: GROUP, identifier: IDENTIFIER, value: alias }
    try {
      if (this.#savedKey) {
        await fetch(USER_DATA, {
          method: 'PUT',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, key: this.#savedKey }),
        })
        return
      }
      const response = await fetch(USER_DATA, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      this.#savedKey = response.headers.get('umb-generated-resource') ?? undefined
    } catch {
      // Kept in this browser regardless; another will start from its own.
    }
  }

  #choose(alias) {
    this.#context?.setThemeByAlias(alias)
    this.#save(alias)
    this.renderRoot.querySelector('#crombolo-theme-menu')?.hidePopover?.()
  }

  render() {
    const current = CHOICES.find((choice) => choice.alias === this._alias) ?? CHOICES[0]
    return html`
      <uui-button
        compact
        look="primary"
        label="Light or dark: ${current.label}"
        popovertarget="crombolo-theme-menu">
        <umb-icon name=${current.icon}></umb-icon>
      </uui-button>
      <uui-popover-container id="crombolo-theme-menu" placement="bottom-end">
        <umb-popover-layout>
          ${CHOICES.map(
            (choice) => html`<uui-menu-item
                label=${choice.label}
                ?active=${choice.alias === this._alias}
                @click-label=${() => this.#choose(choice.alias)}>
                <umb-icon slot="icon" name=${choice.icon}></umb-icon>
              </uui-menu-item>`,
          )}
        </umb-popover-layout>
      </uui-popover-container>
    `
  }

  static styles = css`
    uui-button {
      font-size: 18px;
      --uui-button-background-color: var(--umb-header-app-button-background-color, transparent);
      --uui-button-background-color-hover: var(
        --umb-header-app-button-background-color-hover,
        var(--uui-color-emphasis)
      );
    }
    :host {
      --uui-menu-item-flat-structure: 1;
    }
    umb-popover-layout {
      min-width: 12rem;
    }
  `
}

customElements.define('crombolo-theme-switch', CromboloThemeSwitchElement)
