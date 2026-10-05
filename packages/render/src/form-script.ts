/**
 * The progressive-enhancement script for a rendered form.
 *
 * Held as a string rather than a file so it travels with the package and needs
 * no build step or path resolution. It is small on purpose: the server
 * re-evaluates every condition anyway, so this only decides what a visitor
 * *sees* between keystrokes. A visitor without JavaScript gets the server's
 * answer when they submit, which is the same answer.
 *
 * Mirrors `isShown`/`evaluateRule` in `@bunbraco/core`. The two are kept in
 * step by `tests/forms-conditions.test.ts`, which runs the same cases through
 * both.
 */
export const FORM_SCRIPT_PATH = '/bunbraco/forms.js'

export const FORM_SCRIPT = `/* bunbraco form conditions */
(function () {
  if (window.__bunbracoForms) return

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
      element.hidden = !visible
      // A hidden field must not be required, or the browser refuses to submit a
      // form over something nobody can see.
      var wasRequired = element.getAttribute('data-required') === 'true'
      var inputs = element.querySelectorAll('input, select, textarea')
      for (var j = 0; j < inputs.length; j++) {
        var input = inputs[j]
        if (visible) {
          if (input.dataset.bunbracoRequired === 'true' || wasRequired) input.required = true
        } else {
          if (input.required) input.dataset.bunbracoRequired = 'true'
          input.required = false
        }
      }
    }
  }

  function attach(form) {
    apply(form)
    form.addEventListener('input', function () { apply(form) })
    form.addEventListener('change', function () { apply(form) })
  }

  // Also the guard against running twice, which two forms on a page would
  // otherwise do. Exposed rather than a bare flag so the suite can hold these
  // two functions against the server's own -- see tests/forms-conditions.
  window.__bunbracoForms = { rule: rule, shown: shown, apply: apply }

  var forms = document.querySelectorAll('form.bunbraco-form')
  for (var i = 0; i < forms.length; i++) attach(forms[i])
})();
`
