/**
 * The Forms section's designer, against the real backoffice.
 */
import { expect, signIn, test } from './fixtures.ts'

const FORMS_API = '/crombolo/crombolo/api/forms'

test('a Send email workflow is given an e-mail design, and saved', async ({
  page,
  diagnostics,
}) => {
  // The refused save below is the server answering 400 with its reasons, by design
  diagnostics.allowed.push(`400 PUT ${FORMS_API}`, 'status of 400 (Bad Request)')
  // Its own form, so a rerun against the same site adds something new
  const alias = `mail${Math.random().toString(36).slice(2, 7)}`
  const key = crypto.randomUUID()
  await signIn(page)
  const created = await page.request.put(FORMS_API, {
    data: {
      key,
      alias,
      name: `Mail ${alias}`,
      storeEntries: true,
      pages: [
        {
          groups: [
            {
              columns: 1,
              fields: [{ alias: 'email', type: 'email', caption: 'Email', values: [], accept: [] }],
            },
          ],
        },
      ],
      workflows: [],
    },
  })
  expect(created.status()).toBe(200)

  // The section opens on Entries; the designer is its Forms view
  await page.goto('/crombolo/section/forms/view/forms')
  await page
    .locator('uui-table-row', { hasText: alias })
    .getByRole('button', { name: 'Edit' })
    .click()
  await page.getByRole('button', { name: 'Add a workflow' }).click()
  const workflow = page.locator('section.workflow')
  await expect(workflow).toHaveCount(1)

  // Saved without a subject first: refused, and the refusal says where in words
  await workflow.getByRole('textbox', { name: 'Send to' }).fill('team@example.com')
  await workflow.getByRole('textbox', { name: 'Send to' }).press('Tab')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('alert')).toContainText('Send an e-mail: Subject')

  await workflow.getByRole('textbox', { name: 'Subject' }).fill('New enquiry from {email}')
  await workflow.getByRole('textbox', { name: 'Subject' }).press('Tab')
  const design = workflow.getByRole('combobox', { name: 'E-mail design' })
  await expect(design.locator('option')).toHaveText(['Standard', 'Receipt'])
  await design.selectOption({ label: 'Receipt' })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Form saved').first()).toBeVisible()

  const saved = (await (await page.request.get(`${FORMS_API}/${key}`)).json()) as {
    definition: { workflows: { type: string; settings: Record<string, unknown> }[] }
  }
  expect(saved.definition.workflows).toHaveLength(1)
  expect(saved.definition.workflows[0]).toMatchObject({
    type: 'sendEmail',
    settings: {
      to: 'team@example.com',
      subject: 'New enquiry from {email}',
      template: 'emails/receipt',
    },
  })
  await page.request.delete(`${FORMS_API}/${key}`)
})
