/**
 * The form designer's layout operations: pages, groups and fields moved, added
 * and removed. Pure — each takes a form and answers a new one, leaving the
 * argument untouched — so the designer's element only has to render, and each
 * operation is tested on its own (tests/forms-layout.test.ts).
 */

const copy = (form) => structuredClone(form)

/** `list` with the item at `from` moved to `to`, clamped to the list. */
export function moved(list, from, to) {
  const out = [...list]
  if (from < 0 || from >= out.length) return out
  const [item] = out.splice(from, 1)
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item)
  return out
}

export const emptyGroup = () => ({ columns: 1, fields: [] })
export const emptyPage = () => ({ groups: [emptyGroup()] })

/** Every page with at least one group, which is what the designer edits. */
export function withLayout(form) {
  const next = copy(form)
  next.pages = next.pages?.length ? next.pages : [emptyPage()]
  for (const page of next.pages) page.groups = page.groups?.length ? page.groups : [emptyGroup()]
  return next
}

export function addPage(form) {
  const next = copy(form)
  next.pages.push(emptyPage())
  return next
}

export function movePage(form, index, to) {
  const next = copy(form)
  next.pages = moved(next.pages, index, to)
  return next
}

/** A form keeps one page at least: the last one cannot be removed. */
export function removePage(form, index) {
  if (form.pages.length <= 1) return form
  const next = copy(form)
  next.pages.splice(index, 1)
  return next
}

export function setPageCaption(form, index, caption) {
  const next = copy(form)
  if (caption.trim()) next.pages[index].caption = caption
  else delete next.pages[index].caption
  return next
}

export function addGroup(form, page) {
  const next = copy(form)
  next.pages[page].groups.push(emptyGroup())
  return next
}

export function moveGroup(form, page, index, to) {
  const next = copy(form)
  next.pages[page].groups = moved(next.pages[page].groups, index, to)
  return next
}

/** A page keeps one group at least. */
export function removeGroup(form, page, index) {
  if (form.pages[page].groups.length <= 1) return form
  const next = copy(form)
  next.pages[page].groups.splice(index, 1)
  return next
}

export function setGroupCaption(form, page, index, caption) {
  const next = copy(form)
  if (caption.trim()) next.pages[page].groups[index].caption = caption
  else delete next.pages[page].groups[index].caption
  return next
}

/** Between 1 and 4, as the file allows. */
export function setColumns(form, page, index, columns) {
  const next = copy(form)
  next.pages[page].groups[index].columns = Math.max(1, Math.min(4, Math.round(columns) || 1))
  return next
}

/**
 * Moves a field to a place, `{ page, group, index }`, in its own group or
 * another. Within one group the index is where it ends up.
 */
export function moveField(form, from, to) {
  const next = copy(form)
  const source = next.pages[from.page]?.groups[from.group]?.fields
  const target = next.pages[to.page]?.groups[to.group]?.fields
  if (!source || !target || from.index < 0 || from.index >= source.length) return form
  const [field] = source.splice(from.index, 1)
  target.splice(Math.max(0, Math.min(to.index, target.length)), 0, field)
  return next
}

/** One step up or down within a group, or into the neighbouring group at its edge. */
export function nudgeField(form, at, step) {
  const groups = form.pages.flatMap((page, p) => page.groups.map((_, g) => ({ page: p, group: g })))
  const here = groups.findIndex((place) => place.page === at.page && place.group === at.group)
  const fields = form.pages[at.page].groups[at.group].fields
  const index = at.index + step
  if (index >= 0 && index < fields.length) return moveField(form, at, { ...at, index })
  const neighbour = groups[here + step]
  if (!neighbour) return form
  const length = form.pages[neighbour.page].groups[neighbour.group].fields.length
  return moveField(form, at, { ...neighbour, index: step < 0 ? length : 0 })
}

/** Whether removing it would take fields with it, so the designer asks first. */
export const pageHasFields = (page) => page.groups.some((group) => group.fields.length > 0)
export const groupHasFields = (group) => group.fields.length > 0

/** The group's fields laid out in rows of `columns`, as the rendered form arranges them. */
export function layoutRows(group) {
  const rows = []
  for (let at = 0; at < group.fields.length; at += group.columns)
    rows.push(group.fields.slice(at, at + group.columns))
  return rows
}
