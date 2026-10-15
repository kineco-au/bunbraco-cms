/**
 * The button on the client's own sign-in screen.
 *
 * `umb-auth-view` draws one button per registered `authProvider`, and the
 * vendored manifest contributes `Umb.AuthProviders.Umbraco` — label `Umbraco`,
 * icon `icon-umbraco` — which the default button renders through
 * `login_signInWith` as "Sign in with Umbraco" under the Umbraco mark. There is
 * one way into this backoffice, so the button names no product at all.
 *
 * **Re-registered rather than replaced through `overwrites`.** The registry
 * resolves `overwrites` where an extension is *rendered*, not in `byType`, and
 * `app-auth.controller.js` reads `byType('authProvider')` to decide whether to
 * draw this screen at all: with exactly one provider it skips it and sends the
 * browser straight to the login page. An `overwrites` manifest would leave two
 * providers in that list and so introduce a screen that signing in does not
 * currently show.
 *
 * That same count is why the screen below is reached by a session timing out
 * rather than by signing in: a logged-out visitor is redirected before it
 * renders.
 *
 * `forProviderName` stays `Umbraco`. It is the identity provider the server's
 * authorize endpoint knows, and the view hides a provider by that name when
 * local login is disabled (`umb-auth-view.element.js`). Nothing displays it.
 */
import { css, html, LitElement } from '@umbraco-cms/backoffice/external/lit'
import '@umbraco-cms/backoffice/external/uui'

const TAG = 'crombolo-auth-provider'
const VENDORED = 'Umb.AuthProviders.Umbraco'

/**
 * English, like the login page's own buttons (`assets/login.js`). The two
 * screens are the same step and should use the same word for it, which matters
 * more here than half-translating one of them.
 */
const LABEL = 'Sign in'

class CromboloAuthProviderElement extends LitElement {
  static properties = {
    manifest: { attribute: false },
    userLoginState: { attribute: false },
    onSubmit: { attribute: false },
  }

  render() {
    return html`<uui-button
      type="button"
      look="primary"
      color="positive"
      label=${LABEL}
      @click=${() => this.onSubmit?.(this.manifest)}>
      ${LABEL}
    </uui-button>`
  }

  static styles = css`
    :host {
      display: block;
    }
    uui-button {
      width: 100%;
    }
  `
}

if (!customElements.get(TAG)) customElements.define(TAG, CromboloAuthProviderElement)

/**
 * Signing in again after a timeout closes its modal twice.
 *
 * `umb-app-auth-modal` submits when the session reports itself authorised, and
 * `umb-auth-view` calls the same submit as its `onSuccess` once
 * `makeAuthorizationRequest` returns. Whichever runs first closes the modal and
 * destroys its value state, so the second's `value = { success: true }` throws
 * `_subject is undefined` — and the view shows that as a sign-in error, though
 * the editor is signed in. The second assignment has nothing left to say, so it
 * is dropped. Patched on the element's prototype, as `tsx-editors.js` patches
 * upstream, rather than in the vendored bundle.
 */
async function guardTimedOutSignIn() {
  const Modal = await customElements.whenDefined('umb-app-auth-modal')
  let descriptor
  for (let proto = Modal.prototype; proto && !descriptor; proto = Object.getPrototypeOf(proto))
    descriptor = Object.getOwnPropertyDescriptor(proto, 'value')
  if (!descriptor?.set) return
  const { get, set } = descriptor
  Object.defineProperty(Modal.prototype, 'value', {
    configurable: true,
    get,
    set(value) {
      if (this.__cromboloSubmitted) return
      set.call(this, value)
      this.__cromboloSubmitted = true
    },
  })
}

export const onInit = (_host, extensionRegistry) => {
  void guardTimedOutSignIn()
  extensionRegistry.unregister(VENDORED)
  extensionRegistry.register({
    type: 'authProvider',
    alias: 'Crombolo.AuthProvider.SignIn',
    name: 'Crombolo Sign-in Provider',
    forProviderName: 'Umbraco',
    elementName: TAG,
    weight: 1000,
    meta: { label: LABEL },
  })
}
