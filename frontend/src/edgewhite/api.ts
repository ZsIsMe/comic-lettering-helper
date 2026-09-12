export { api, json } from '../workbench-api'
export const collectionUrl = (id: string) => `/api/edgewhite/${encodeURIComponent(id)}`
export const sourceUrl = (id: string, page: string) => `${collectionUrl(id)}/pages/${encodeURIComponent(page)}/source`
export { inputFiles } from './file-selection'
