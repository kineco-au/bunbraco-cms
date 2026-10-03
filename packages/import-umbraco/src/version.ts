/**
 * Which Umbraco version a database is at.
 *
 * Umbraco records its upgrade plan's state in `umbracoKeyValue`, as the GUID of
 * the last migration that ran. The table below maps every state from 10.0 to
 * 18.1 to the version whose migration reached it, and was extracted from
 * `UmbracoPlan.cs` at the last release of each major (13.16, 14.3, 15.4, 16.5,
 * 17.7, 18.2). A patch release adds no migrations of its own, so a database
 * reports the last release that changed the schema: a 17.7 site reads as 17.6.
 */
import type { Source } from './source.ts'

/** Upgrade state → the version that reached it, oldest first. */
export const UPGRADE_STATES: ReadonlyArray<readonly [state: string, version: string]> = [
  ['b7e0d53c-2b0e-418b-ab07-2dde486e225f', '10.0.0'],
  ['d0b3d29d-f4d5-43e3-ba67-9d49256f3266', '10.2.0'],
  ['79d8217b-5920-4c0e-8e9a-3cf8fa021882', '10.2.0'],
  ['56833770-3b7e-4fd5-a3b6-3416a26a7a3f', '10.3.0'],
  ['3f5d492a-a3db-43f9-a73e-9fee3b180e6c', '10.4.0'],
  ['83af7945-dade-4a02-9041-f3f6ebfac319', '10.5.0'],
  ['bb3889ed-e2de-49f2-8f71-5fd8616a2661', '11.3.0'],
  ['ffb6b9b0-f1a8-45e9-9cd7-25700577d1ca', '11.4.0'],
  ['888a0d5d-51e4-4c7e-aa0a-01306523c7fb', '12.0.0'],
  ['539f2f83-fba7-4c48-81a3-75081a56bb9d', '12.0.0'],
  ['1187192d-edb5-4619-955d-91d48d738871', '12.1.0'],
  ['47de85ce-1e16-42a0-8af6-3ec3bcef5471', '12.1.0'],
  ['c76d9c9a-635b-4d2c-a301-05642a523e9d', '13.0.0'],
  ['d5139400-e507-4259-a542-c67358f7e329', '13.0.0'],
  ['4e652f18-9a29-4656-a899-e3f39069c47e', '13.0.0'],
  ['148714c8-fe0d-4553-b034-439d91468761', '13.0.0'],
  ['23ba95a4-fcce-49b0-8aa1-45312b103a9b', '13.0.0'],
  ['7ddce198-9ca4-430c-8bbc-a66d80ca209f', '13.0.0'],
  ['f74cda0c-7aaa-48c8-94c6-c6ec3c06f599', '13.0.0'],
  ['21c42760-5109-4c03-ab4f-7ea53577d1f5', '13.0.0'],
  ['6158f3a3-4902-4201-835e-1ed7f810b2d8', '13.0.0'],
  ['985af2ba-69d3-4dba-95e0-ad3fa7459fa7', '13.3.0'],
  ['cc47c751-a81b-489a-a2bc-0240245db687', '13.5.0'],
  ['eef792fc-318c-4921-9859-51ebf07a53a3', '13.5.0'],
  ['419827a0-4fce-464b-a8f3-247c6092af55', '14.0.0'],
  ['e073dbc0-9e8e-4c92-8210-9cb18364f46e', '14.0.0'],
  ['80d282a4-5497-47ff-991f-bc0bce603121', '14.0.0'],
  ['96525697-e9dc-4198-b136-25ad033442b8', '14.0.0'],
  ['7fc5ac9b-6f56-415b-913e-4a900629b853', '14.0.0'],
  ['1539a010-2eb5-4163-8518-4ae2aa98afc6', '14.0.0'],
  ['0d82c836-96dd-480d-a924-7964e458bd34', '14.0.0'],
  ['1a0fbc8a-6fc6-456c-805c-b94816b2e570', '14.0.0'],
  ['302de171-6d83-4b6b-b3c0-ac8808a16ca1', '14.0.0'],
  ['8184e61d-ecba-4aaa-b61b-d7a82eb82eb7', '14.0.0'],
  ['e261bf01-2c7f-4544-bae7-49d545b21d68', '14.0.0'],
  ['5a2ef07d-37b4-49d5-8e9b-3ed01877263b', '14.0.0'],
  ['6fb5ca9e-c823-473b-a14c-fe760d75943c', '14.0.0'],
  ['827360ca-0855-42a5-8f86-a51f168cb559', '14.0.0'],
  ['fef2daf4-5408-4636-bb0e-b8798df8f095', '14.1.0'],
  ['a385c5df-48dc-46b4-a742-d5bb846483bc', '14.1.0'],
  ['20ed404c-6ff9-4f91-8ac9-2b298e0002eb', '14.2.0'],
  ['7f4f31d8-dd71-4f0d-93fc-2690a924d84b', '15.0.0'],
  ['3fe0fa2d-cf4f-4892-ba8d-e97d06e028dc', '15.0.0'],
  ['6c04b137-0097-4938-8c6a-276df1a0eca8', '15.0.0'],
  ['9d3ce7d4-4884-41d4-98e8-302eb6cb0cf6', '15.0.0'],
  ['37875e80-5cdd-42ff-a21a-7d4e3e23e0ed', '15.0.0'],
  ['42e44f9e-7262-4269-922d-7310cb48e724', '15.0.0'],
  ['7b51b4de-5574-4484-993e-05d12d9ed703', '15.1.0'],
  ['f3d3ef46-1b1f-47db-b437-7d573eedeb98', '15.1.0'],
  ['7b11f01e-ee33-4b0b-81a1-f78f834ca45b', '15.3.0'],
  ['a9e72794-4036-4563-b543-1717c73b8879', '15.4.0'],
  ['33d62294-d0de-4a86-a830-991eb36b96da', '15.4.0'],
  ['c6681435-584f-4bc8-bb8d-bc853966af0b', '16.0.0'],
  ['d1568c33-a697-455f-8d16-48060cb954a1', '16.0.0'],
  ['741c22cf-5fb8-4343-bf79-b97a58c2ccba', '16.2.0'],
  ['a917fcbc-c378-4a08-a36c-220c581a6581', '16.3.0'],
  ['fb7073af-dfaf-4ac1-800d-91f9bd5b5238', '16.3.0'],
  ['6a7d3b80-8b64-4e41-a7c0-02ec39336e97', '16.4.0'],
  ['17d5f6ca-ceb8-462a-af86-4b9c3bf91cf1', '17.0.0'],
  ['eb1e50b7-cd5e-4b6b-b307-36237dd2c506', '17.0.0'],
  ['1847c7ff-b021-44eb-beb0-a77a4376a6f2', '17.0.0'],
  ['7208b20d-6bfc-472e-9374-85eea817b27d', '17.0.0'],
  ['263075bf-f18a-480d-92b4-4947d2eab772', '17.0.0'],
  ['26179d88-58ce-4c92-b4a4-3cba6e7188ac', '17.0.0'],
  ['8b2c830a-4ffb-4433-8337-8649b0bf52c8', '17.0.0'],
  ['1c38d589-26bb-4a46-9abe-e4a0df548a87', '17.0.0'],
  ['be5ca411-e12d-4455-a59e-f12a669e5363', '17.0.1'],
  ['1ce2e78b-e736-45d8-97a2-ce3ef2f31bcd', '17.1.0'],
  ['f1a2b3c4-d5e6-4789-abcd-1234567890ab', '17.2.0'],
  ['a7b8c9d0-e1f2-4a5b-8c7d-9e0f1a2b3c4d', '17.2.0'],
  ['a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d', '17.3.0'],
  ['b2f4a1c3-8d5e-4f6a-9b7c-3e1d2a4f5b6c', '17.3.0'],
  ['0638e0e0-d914-4aca-8a4b-9551a3aab91f', '17.3.0'],
  ['e4a7c2d1-5f38-4b96-a1d3-8e2f6c9b0a74', '17.3.0'],
  ['b8c9d0e1-f2a3-4b5c-8d7e-9f0a1b2c3d4e', '17.3.0'],
  ['9dbdb5cd-8679-4bb0-bf83-e8d508073ce0', '17.3.0'],
  ['6748cb56-cc16-49f0-ba91-b8ece31bf456', '17.3.0'],
  ['d4e5f6a7-b8c9-4d0e-a1f2-3b4c5d6e7f80', '17.4.0'],
  ['72970b86-59d8-403c-b322-fff43f9db199', '17.4.0'],
  ['d7e8f9a0-b1c2-4d3e-a5f6-7890abcdef12', '17.4.0'],
  ['3f9b6a1c-7d84-4e2b-9c15-6a2e8f3d5b47', '17.4.0'],
  ['3a1a8047-74ae-491a-b2c4-0bae4a1289ec', '17.6.0'],
  ['74332c49-b279-4945-8943-f8f00b1f5949', '18.0.0'],
  ['d00bb11a-ddf8-47c4-b58e-150c123bb3bb', '18.0.0'],
  ['6fe4656e-8b8d-452f-ae2a-438a615b61bc', '18.0.0'],
  ['ae533af6-4611-4e25-aa4d-89aefa468e79', '18.1.0'],
]

const VERSION_OF = new Map(UPGRADE_STATES)

/** The oldest major the importer converts; anything older is told to upgrade first. */
export const MINIMUM_MAJOR = 15
/** The newest major whose shape this importer has been written against. */
export const NEWEST_MAJOR = 18

export const UPGRADE_STATE_KEY = 'Umbraco.Core.Upgrader.State+Umbraco.Core'

export type VersionStatus =
  /** A version the importer converts. */
  | 'supported'
  /** Older than the minimum: upgrade with Umbraco first. */
  | 'too-old'
  /** Newer than anything this importer knows; it may still work. */
  | 'newer'
  /** Not recognisably an Umbraco database, or one from before version 10. */
  | 'unknown'

export interface DetectedVersion {
  /** `17.0.0`, or undefined when the state is not one this importer knows. */
  version?: string
  major?: number
  state?: string
  status: VersionStatus
}

export function versionForState(state: string): string | undefined {
  return VERSION_OF.get(state.replace(/[{}]/g, '').toLowerCase())
}

export function detectVersion(source: Source): DetectedVersion {
  if (!source.has('umbracoKeyValue') || !source.has('umbracoNode')) return { status: 'unknown' }
  const row = source.one<{ value: string | null }>(
    'SELECT value FROM umbracoKeyValue WHERE "key" = ?',
    UPGRADE_STATE_KEY,
  )
  const state = row?.value?.replace(/[{}]/g, '').toLowerCase()
  if (!state) return { status: 'unknown' }
  const version = versionForState(state)
  if (!version) {
    // A state this table has never seen, on a database with the current shape,
    // is a release newer than the table.
    return { state, status: source.has('umbracoPropertyData') ? 'newer' : 'unknown' }
  }
  const major = Number(version.split('.')[0])
  return {
    version,
    major,
    state,
    status: major < MINIMUM_MAJOR ? 'too-old' : major > NEWEST_MAJOR ? 'newer' : 'supported',
  }
}
