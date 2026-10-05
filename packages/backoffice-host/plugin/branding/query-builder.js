/**
 * The template editor's query builder writes TypeScript, so it should not say
 * it wrote C#.
 *
 * The modal hard-codes `language="C#"` on the code block it previews the
 * snippet in (`query-builder-modal.element.js`). The element is vendored, so
 * the label is corrected after each render rather than by replacing the modal:
 * the rest of it — the pickers, the filters, the sample results — is exactly
 * what we want, and a fork of it would be a fork to maintain.
 */
const TAG = 'umb-template-query-builder-modal'
const LANGUAGE = 'TypeScript'

export const onInit = async () => {
  // The modal is registered lazily, so the class may not be defined until the
  // editor opens it.
  const element = await customElements.whenDefined(TAG)
  const prototype = element.prototype
  const updated = prototype.updated
  prototype.updated = function patched(changed) {
    updated?.call(this, changed)
    const block = this.shadowRoot?.querySelector('umb-code-block')
    if (block && block.getAttribute('language') !== LANGUAGE) {
      block.setAttribute('language', LANGUAGE)
      block.language = LANGUAGE
    }
  }
}
