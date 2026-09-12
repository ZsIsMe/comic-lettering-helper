export type Item = {
  _id: string; text: string; x: number; y: number; 'font-size': number; rotation: number;
  orientation: 'vertical' | 'horizontal'; color: string; 'stroke-color': string; 'stroke-weight': number;
  xyxy_pixel?: number[]; index?: number; groupId?: number; match_status?: string; need_inpaint?: boolean;
  [key: string]: unknown;
}
export type Page = { id: string; name: string; width: number; height: number; revision: number; sha256: string; clean: string | null; clean_kind?: 'uploaded' | 'inpainted' }
export type Measure = { xyxy_pixel?: number[]; center_normalized?: number[]; font_size?: number; orientation?: string; text_color?: string; text_has_stroke?: boolean; [key: string]: unknown }
export type PageData = Page & { items: Item[]; measure: Measure[] }
export type Project = { id: string; name: string; updated_at: string; revision: number; pages: Page[]; detection_id: string | null }
export type Availability = { methods: Record<string, boolean>; assets: Record<string, boolean>; font_version?: string; runtime: boolean; device?: string; gpu_owner: string | null }
export type Detection = { id: string; state: string; device?: string; message?: string; progress?: { completed: number; total: number; stage: string } }
export const uid = () => `t_${crypto.randomUUID().replaceAll('-', '')}`
export const activeDetection = (task: Detection | null) => !!task && ['queued', 'validating', 'detecting', 'aligning', 'measuring', 'previewing', 'calibrating', 'publishing', 'cancelling', 'recovery_required'].includes(task.state)
