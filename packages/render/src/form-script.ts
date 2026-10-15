/**
 * The progressive-enhancement script for a rendered form: conditions, and
 * stepping a `step-pages` form one page at a time.
 *
 * Held as a string rather than a file so it travels with the package and needs
 * no build step or path resolution. It is small on purpose: the server
 * re-evaluates every condition anyway, so this only decides what a visitor
 * *sees* between keystrokes. A visitor without JavaScript gets the server's
 * answer when they submit, which is the same answer.
 *
 * Mirrors `isShown`/`evaluateRule` in `@crombolo/core`. The two are kept in
 * step by `tests/forms-conditions.test.ts`, which runs the same cases through
 * both.
 */
import { FORM_PAGE_FIELD } from '@crombolo/core'

export const FORM_SCRIPT_PATH = '/crombolo/forms.js'

export const FORM_SCRIPT = `/* crombolo forms: conditions and stepped pages */
(function () {
  if (window.__cromboloForms) return

  function valuesOf(form, alias) {
    var out = []
    var inputs = form.querySelectorAll('[name="' + alias.replace(/"/g, '\\\\"') + '"]')
    for (var i = 0; i < inputs.length; i++) {
      var input = inputs[i]
      if ((input.type === 'checkbox' || input.type === 'radio') && !input.checked) continue
      if (input.value !== undefined && String(input.value).trim() !== '') out.push(String(input.value).trim())
    }
    return out
  }

  function numeric(a, b) {
    var x = Number(a)
    var y = Number(b)
    return isFinite(x) && isFinite(y) ? x - y : undefined
  }

  function rule(form, r) {
    var values = valuesOf(form, r.field)
    var target = r.value === undefined ? '' : r.value
    var first = values.length > 0 ? values[0] : ''
    switch (r.operator) {
      case 'is': return values.indexOf(target) !== -1
      case 'isNot': return values.indexOf(target) === -1
      case 'contains': return values.some(function (v) { return v.indexOf(target) !== -1 })
      case 'doesNotContain': return !values.some(function (v) { return v.indexOf(target) !== -1 })
      case 'startsWith': return first.indexOf(target) === 0
      case 'endsWith': return first.length >= target.length && first.slice(first.length - target.length) === target
      case 'greaterThan': {
        var g = numeric(first, target)
        return g === undefined ? first > target : g > 0
      }
      case 'lessThan': {
        var l = numeric(first, target)
        return l === undefined ? first < target : l < 0
      }
      case 'isEmpty': return values.length === 0
      case 'isNotEmpty': return values.length > 0
      default: return true
    }
  }

  function shown(form, condition) {
    if (!condition || !condition.rules || condition.rules.length === 0) return true
    var matched = condition.match === 'any'
      ? condition.rules.some(function (r) { return rule(form, r) })
      : condition.rules.every(function (r) { return rule(form, r) })
    return condition.action === 'hide' ? !matched : matched
  }

  function apply(form) {
    var conditional = form.querySelectorAll('[data-condition]')
    for (var i = 0; i < conditional.length; i++) {
      var element = conditional[i]
      var condition
      try {
        condition = JSON.parse(element.getAttribute('data-condition'))
      } catch (error) {
        continue
      }
      var visible = shown(form, condition)
      // A stepped form's page is shown by the stepper, which skips one its
      // condition hides; everything else is shown or hidden here.
      if (stepped(form) && element.classList.contains('crombolo-form__page'))
        element.setAttribute('data-condition-hidden', visible ? 'false' : 'true')
      else element.hidden = !visible
      // A hidden field must not be required, or the browser refuses to submit a
      // form over something nobody can see.
      var wasRequired = element.getAttribute('data-required') === 'true'
      var inputs = element.querySelectorAll('input, select, textarea')
      for (var j = 0; j < inputs.length; j++) {
        var input = inputs[j]
        if (visible) {
          if (input.dataset.cromboloRequired === 'true' || wasRequired) input.required = true
        } else {
          if (input.required) input.dataset.cromboloRequired = 'true'
          input.required = false
        }
      }
    }
  }

  function stepped(form) {
    return form.getAttribute('data-step-pages') === 'true'
  }

  function pagesOf(form) {
    return Array.prototype.slice.call(form.querySelectorAll('.crombolo-form__page'))
  }

  function open(page) {
    return page.getAttribute('data-condition-hidden') !== 'true'
  }

  /** The next page a visitor can reach from \`from\`, going \`step\` (1 or -1); -1 when none. */
  function neighbour(form, from, step) {
    var pages = pagesOf(form)
    for (var i = from + step; i >= 0 && i < pages.length; i += step) if (open(pages[i])) return i
    return -1
  }

  function current(form) {
    return Number(form.getAttribute('data-step-current') || 0)
  }

  function layout(form) {
    if (!stepped(form)) return
    var pages = pagesOf(form)
    var at = current(form)
    // A condition can close the page a visitor is on: step back to one that is open.
    if (!pages[at] || !open(pages[at])) {
      var back = neighbour(form, at, -1)
      at = back === -1 ? neighbour(form, -1, 1) : back
      form.setAttribute('data-step-current', String(at))
    }
    for (var i = 0; i < pages.length; i++) pages[i].hidden = i !== at
    var last = neighbour(form, at, 1) === -1
    var buttons = {
      back: form.querySelector('[data-step="back"]'),
      next: form.querySelector('[data-step="next"]'),
      submit: form.querySelector('.crombolo-form__submit'),
    }
    if (buttons.back) buttons.back.hidden = neighbour(form, at, -1) === -1
    if (buttons.next) buttons.next.hidden = last
    if (buttons.submit) buttons.submit.hidden = !last
  }

  function showErrors(page, errors) {
    var old = page.querySelectorAll('[data-step-error]')
    for (var i = 0; i < old.length; i++) old[i].parentNode.removeChild(old[i])
    var marked = page.querySelectorAll('.crombolo-form__field--invalid')
    for (var j = 0; j < marked.length; j++) marked[j].classList.remove('crombolo-form__field--invalid')
    var first = null
    for (var k = 0; k < errors.length; k++) {
      var field = page.querySelector('[data-field="' + errors[k].field + '"]')
      if (!field) continue
      field.classList.add('crombolo-form__field--invalid')
      var message = document.createElement('p')
      message.className = 'crombolo-form__error'
      message.setAttribute('role', 'alert')
      message.setAttribute('data-step-error', 'true')
      message.textContent = errors[k].message
      field.appendChild(message)
      if (!first) first = field.querySelector('input, select, textarea')
    }
    if (first) first.focus()
  }

  function go(form, to) {
    form.setAttribute('data-step-current', String(to))
    layout(form)
    var page = pagesOf(form)[to]
    if (page && page.scrollIntoView) page.scrollIntoView({ block: 'start' })
    var input = page && page.querySelector('input:not([type="hidden"]), select, textarea')
    if (input) input.focus()
  }

  /** Checks this page on the server, then moves on. A failure to reach it moves on too: the submit checks everything. */
  function next(form) {
    var at = current(form)
    var to = neighbour(form, at, 1)
    if (to === -1) return
    var button = form.querySelector('[data-step="next"]')
    if (button) button.disabled = true
    var data = new FormData(form)
    data.set('${FORM_PAGE_FIELD}', String(at))
    fetch(form.action, {
      method: 'POST',
      body: data,
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    })
      .then(function (response) {
        return response.json().catch(function () { return { ok: response.ok } })
      })
      .catch(function () { return { ok: true } })
      .then(function (result) {
        if (button) button.disabled = false
        var page = pagesOf(form)[at]
        if (result && result.ok === false && result.errors) return showErrors(page, result.errors)
        showErrors(page, [])
        go(form, to)
      })
  }

  function attachSteps(form) {
    if (!stepped(form)) return
    // After a refused submission, open on the first page the server complained about.
    var pages = pagesOf(form)
    for (var i = 0; i < pages.length; i++)
      if (pages[i].querySelector('.crombolo-form__field--invalid')) {
        form.setAttribute('data-step-current', String(i))
        break
      }
    layout(form)
    var nextButton = form.querySelector('[data-step="next"]')
    var backButton = form.querySelector('[data-step="back"]')
    if (nextButton) nextButton.addEventListener('click', function () { next(form) })
    if (backButton)
      backButton.addEventListener('click', function () {
        var to = neighbour(form, current(form), -1)
        if (to !== -1) go(form, to)
      })
    // Enter on an earlier page means "next", not "submit".
    form.addEventListener('submit', function (event) {
      if (neighbour(form, current(form), 1) === -1) return
      event.preventDefault()
      next(form)
    })
  }

  function attach(form) {
    apply(form)
    attachSteps(form)
    form.addEventListener('input', function () { apply(form); layout(form) })
    form.addEventListener('change', function () { apply(form); layout(form) })
  }

  // Also the guard against running twice, which two forms on a page would
  // otherwise do. Exposed rather than a bare flag so the suite can hold these
  // two functions against the server's own -- see tests/forms-conditions.
  window.__cromboloForms = { rule: rule, shown: shown, apply: apply, layout: layout, neighbour: neighbour }

  var forms = document.querySelectorAll('form.crombolo-form')
  for (var i = 0; i < forms.length; i++) attach(forms[i])
})();
`
