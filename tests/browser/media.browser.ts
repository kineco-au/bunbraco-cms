/**
 * WP-6.3 and 6.4's exits in the real backoffice: every built-in property editor
 * renders and saves, including an upload; and an image uploaded in Media,
 * picked on a page and published, renders as a resized crop.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, expectEveryPropertyEditorRenders, goToSection, signIn, test } from './fixtures.ts'

const API = '/umbraco/management/api/v1'
const unique = (name: string) => `${name} ${Math.random().toString(36).slice(2, 7)}`
const halves = () => readFileSync(join(process.cwd(), 'tests/fixtures/halves.png'))

/** Width and height from a PNG's header. */
const pngSize = (bytes: Buffer) => [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]

async function everyEditorPage(page: Page, name: string) {
  const types = await (
    await page.request.get(`${API}/document-type/allowed-at-root?skip=0&take=20`)
  ).json()
  const type = types.items.find((t: { name: string }) => t.name === 'Every editor')
  const detail = await (await page.request.get(`${API}/document-type/${type.id}`)).json()
  const created = await page.request.post(`${API}/document`, {
    data: {
      documentType: { id: type.id },
      template: detail.defaultTemplate,
      parent: null,
      values: [],
      variants: [{ culture: null, segment: null, name }],
    },
  })
  expect(created.status()).toBe(201)
  return created.headers()['umb-generated-resource'] as string
}

test('every built-in property editor renders, and an upload saves as a served file', async ({
  page,
}) => {
  await signIn(page)
  const key = await everyEditorPage(page, unique('Editors'))
  await page.goto(`/bunbraco/section/content/workspace/document/edit/${key}`)
  await expectEveryPropertyEditorRenders(page)

  await page.locator('umb-property-editor-ui-text-box #input').first().fill('Typed')
  await page
    .locator('umb-property')
    .filter({ hasText: 'Upload Article' })
    .locator('input[type=file]')
    .first()
    .setInputFiles({
      name: 'Paper.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.7'),
    })
  await page.getByTestId('workspace-action:Umb.WorkspaceAction.Document.Save').click()

  await expect
    .poll(async () => {
      const doc = await (await page.request.get(`${API}/document/${key}`)).json()
      return (
        doc.values.find((v: { alias: string }) => v.alias === 'uploadArticle')?.value?.src ?? null
      )
    })
    .toMatch(/^\/media\/[0-9a-f]{8}\/paper\.pdf$/)
  const doc = await (await page.request.get(`${API}/document/${key}`)).json()
  const src = doc.values.find((v: { alias: string }) => v.alias === 'uploadArticle').value.src
  expect(await (await page.request.get(src)).text()).toBe('%PDF-1.7')
  expect(doc.values.find((v: { alias: string }) => v.alias === 'textstring')?.value).toBe('Typed')
})

test('an image uploaded to Media, picked on a page and published renders as a resized crop', async ({
  page,
}) => {
  await signIn(page)
  const imageName = unique('Halves')
  await goToSection(page, 'Media')
  // The collection view's dropzone: the file becomes an Image media item
  await page
    .locator('input[type=file]')
    .first()
    .setInputFiles({ name: `${imageName}.png`, mimeType: 'image/png', buffer: halves() })
  // The dropzone names the item from the file, in its own casing
  const suffix = imageName.split(' ')[1] as string
  await expect(page.getByRole('link', { name: new RegExp(suffix, 'i') }).first()).toBeVisible()

  const pageName = unique('Gallery')
  const key = await everyEditorPage(page, pageName)
  await page.goto(`/bunbraco/section/content/workspace/document/edit/${key}`)
  const picker = page.locator('umb-property').filter({ hasText: 'Image Media Picker' }).first()
  await picker.scrollIntoViewIfNeeded()
  await picker
    .getByRole('button', { name: /Choose|Add/ })
    .first()
    .click()
  await page
    .locator('uui-modal-sidebar')
    .last()
    .locator('uui-card-media')
    .filter({ hasText: new RegExp(suffix, 'i') })
    .filter({ visible: true })
    .first()
    .click()
  await page.locator('uui-modal-sidebar').last().getByRole('button', { name: 'Choose' }).click()

  // Rich text: the toolbar's media picker inserts the image
  const richText = page.locator('umb-property').filter({ hasText: 'Richtext editor' }).first()
  await richText.scrollIntoViewIfNeeded()
  await richText.locator('.ProseMirror').click()
  await richText
    .getByRole('button', { name: /media picker/i })
    .first()
    .click()
  await page
    .locator('uui-modal-sidebar')
    .last()
    .locator('uui-card-media')
    .filter({ hasText: new RegExp(suffix, 'i') })
    .filter({ visible: true })
    .first()
    .click()
  await page.locator('uui-modal-sidebar').last().getByRole('button', { name: 'Choose' }).click()
  // Then alt text and size, prefilled from the media item
  await page.locator('uui-modal-sidebar').last().getByRole('button', { name: 'Submit' }).click()
  await page.getByTestId('workspace-action:Umb.WorkspaceAction.Document.SaveAndPublish').click()

  const urls = async () =>
    (await (await page.request.get(`${API}/document/urls?id=${key}`)).json())[0]?.urlInfos[0]
      ?.url ?? null
  await expect.poll(urls).not.toBeNull()
  const html = await (await page.request.get(await urls())).text()
  const hero = /class="hero" src="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&') as string
  expect(hero).toMatch(/^\/media\/[0-9a-f]{8}\/halves-[a-z0-9]+\.png\?width=40&height=40$/)

  // The rich text image renders, and its URL serves
  const doc = await (await page.request.get(`${API}/document/${key}`)).json()
  const markup = doc.values.find((v: { alias: string }) => v.alias === 'richtext')?.value
    ?.markup as string
  const imageSrc = /<img[^>]+src="([^"]+)"/.exec(markup)?.[1]?.replaceAll('&amp;', '&') as string
  expect(imageSrc).toMatch(/^\/media\/[0-9a-f]{8}\/halves-[a-z0-9]+\.png/)
  expect((await page.request.get(imageSrc)).status()).toBe(200)

  const crop = await page.request.get(hero)
  expect(crop.status()).toBe(200)
  expect(crop.headers()['content-type']).toBe('image/png')
  expect(pngSize(await crop.body())).toEqual([40, 40])
})
